import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { DbHelpers } from '../../db/index.js';
import { fetchPricing, computeCost } from '../../pricing.js';

/**
 * Decode Claude Code project dir name to a human-readable project name.
 * e.g. "-Users-saidsalles-apps-bingo-go" → "bingo-go"
 * Worktree dirs like "...--deepflow-worktrees-spike" → "deepflow (spike)"
 */
function projectNameFromDir(dirName: string): string {
  // Split on worktree separator
  const [mainPath, worktreePart] = dirName.split('--', 2);
  // Take last meaningful segment from the path
  const segments = mainPath.replace(/^-+/, '').split('-').filter(Boolean);
  // Walk from end to find the project name (skip user/apps prefix)
  // Pattern: Users-user-apps-projectName or Users-user-apps-org-projectName
  const appsIdx = segments.lastIndexOf('apps');
  const name = appsIdx >= 0 && appsIdx < segments.length - 1
    ? segments.slice(appsIdx + 1).join('-')
    : segments.slice(-1)[0] ?? dirName;

  if (worktreePart) {
    const wtSegments = worktreePart.split('-').filter(Boolean);
    // Remove "deepflow-worktrees" or "claude-worktrees" prefix
    const wtIdx = wtSegments.findIndex(s => s === 'worktrees');
    const suffix = wtIdx >= 0 ? wtSegments.slice(wtIdx + 1).join('-') : wtSegments.join('-');
    return suffix ? `${name} (${suffix})` : name;
  }

  return name;
}

/** Individual subagent entry from registry */
interface SubagentEntry {
  session_id: string;
  agent_type: string;
  agent_id: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  timestamp: string;
}

/**
 * Parses per-session JSONL files in ~/.claude/projects/{project}/ → sessions table.
 * Also creates virtual sessions for each subagent from the registry.
 */
export async function parseSessions(db: DbHelpers, claudeDir: string): Promise<void> {
  const projectsDir = resolve(claudeDir, 'projects');
  if (!existsSync(projectsDir)) {
    console.warn('[ingest:sessions] Projects dir not found, skipping:', projectsDir);
    return;
  }

  let projectDirs: Array<{ path: string; name: string }>;
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        path: join(projectsDir, d.name),
        name: projectNameFromDir(d.name),
      }));
  } catch (err) {
    console.warn('[ingest:sessions] Cannot read projects dir:', err);
    return;
  }

  // Load pricing once for cost computation
  const pricing = await fetchPricing();

  // Load subagent registry
  const registryPath = resolve(claudeDir, 'subagent-sessions.jsonl');
  const registryRoleMap = new Map<string, Set<string>>(); // session_id → Set<agent_type>
  const subagentEntries: SubagentEntry[] = [];            // individual entries with tokens

  if (existsSync(registryPath)) {
    try {
      const registryLines = readFileSync(registryPath, 'utf-8').split('\n');
      for (const line of registryLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          const sid = entry.session_id as string | undefined;
          const atype = entry.agent_type as string | undefined;
          const agentId = entry.agent_id as string | undefined;
          const entryModel = (entry.model as string | undefined) ?? 'unknown';
          if (sid && atype) {
            if (!registryRoleMap.has(sid)) registryRoleMap.set(sid, new Set());
            registryRoleMap.get(sid)!.add(atype);
          }
          // Collect entries that have token data for virtual session creation
          const hasTokens = typeof entry.tokens_in === 'number' || typeof entry.tokens_out === 'number';
          if (sid && agentId && atype && hasTokens) {
            subagentEntries.push({
              session_id: sid,
              agent_type: atype,
              agent_id: agentId,
              model: entryModel.replace(/-\d{8}$/, '').replace(/\[\d+[km]\]$/i, ''),
              tokens_in: (entry.tokens_in as number) ?? 0,
              tokens_out: (entry.tokens_out as number) ?? 0,
              cache_read: (entry.cache_read as number) ?? 0,
              cache_creation: (entry.cache_creation as number) ?? 0,
              timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
            });
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch (err) {
      console.warn('[ingest:sessions] Cannot read subagent registry:', err);
    }
  } else {
    console.warn('[ingest:sessions] subagent-sessions.jsonl not found, all sessions default to orchestrator');
  }

  let totalInserted = 0;
  let totalUpdated = 0;

  for (const projectEntry of projectDirs) {
    // Session JSONL files are directly in the project dir (UUID.jsonl)
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectEntry.path)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(projectEntry.path, f));
    } catch {
      continue;
    }

    for (const filePath of sessionFiles) {
      const offsetKey = `ingest_offset:session:${filePath}`;
      const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
      const offset = offsetRow ? parseInt(offsetRow.value as string, 10) : 0;

      let lines: string[];
      try {
        lines = readFileSync(filePath, 'utf-8').split('\n');
      } catch (err) {
        console.warn(`[ingest:sessions] Cannot read file ${filePath}:`, err);
        continue;
      }

      // Skip if no new lines
      if (lines.length <= offset) continue;

      // Derive session ID from filename (UUID.jsonl)
      const fileSessionId = basename(filePath, '.jsonl');

      let sessionId: string = fileSessionId;
      let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreation = 0;
      let messages = 0, toolCalls = 0;
      let model = 'unknown', user = 'unknown';
      const project = projectEntry.name;
      let startedAt: string | null = null, endedAt: string | null = null;
      let durationMs = 0;
      let hasNewData = false;

      for (let i = offset; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // skip malformed lines silently
        }

        hasNewData = true;

        // Extract session identity
        if (event.sessionId) sessionId = event.sessionId as string;
        if (!startedAt && event.timestamp) startedAt = event.timestamp as string;
        if (event.timestamp) endedAt = event.timestamp as string;

        if (event.user) user = event.user as string;

        // Model: prefer event.message.model, fall back to event.model
        const msg = event.message as Record<string, unknown> | undefined;
        const msgModel = msg?.model as string | undefined;
        const evtModel = event.model as string | undefined;
        const resolvedModel = msgModel ?? evtModel;
        if (resolvedModel && resolvedModel !== 'unknown') model = resolvedModel.replace(/\[\d+[km]\]$/i, '');

        // Count messages by event type
        const eventType = event.type as string | undefined;
        if (eventType === 'assistant' || event.role === 'assistant') messages++;
        if (eventType === 'user' || eventType === 'human' || event.role === 'human' || event.role === 'user') messages++;

        // Count tool_use blocks in message.content
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_use') toolCalls++;
          }
        }

        // Accumulate tokens: prefer event.message.usage, fall back to event.usage
        const msgUsage = msg?.usage as Record<string, number> | undefined;
        const evtUsage = event.usage as Record<string, number> | undefined;
        const usage = msgUsage ?? evtUsage;
        if (usage) {
          tokensIn += usage.input_tokens ?? 0;
          tokensOut += usage.output_tokens ?? 0;
          cacheRead += usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0;
          cacheCreation += usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0;

        }
      }

      // Orchestrator session: keep original model from event stream (don't override from registry)
      // Clamp accumulated token values to non-negative before cost computation and DB writes
      if (tokensIn < 0) { console.warn(`[ingest:sessions] Clamping negative tokensIn (${tokensIn}) to 0 for session ${sessionId}`); tokensIn = 0; }
      if (tokensOut < 0) { console.warn(`[ingest:sessions] Clamping negative tokensOut (${tokensOut}) to 0 for session ${sessionId}`); tokensOut = 0; }
      if (cacheRead < 0) { console.warn(`[ingest:sessions] Clamping negative cacheRead (${cacheRead}) to 0 for session ${sessionId}`); cacheRead = 0; }
      if (cacheCreation < 0) { console.warn(`[ingest:sessions] Clamping negative cacheCreation (${cacheCreation}) to 0 for session ${sessionId}`); cacheCreation = 0; }

      // Compute cost after loop using accumulated tokens + resolved model
      const rawCost = computeCost(pricing, model, tokensIn, tokensOut, cacheRead, cacheCreation);
      const cost = Math.max(0, rawCost);
      if (rawCost < 0) console.warn(`[ingest:sessions] Clamping negative cost (${rawCost}) to 0 for session ${sessionId}`);

      // Calculate duration from timestamps
      if (startedAt && endedAt) {
        const start = new Date(startedAt).getTime();
        const end = new Date(endedAt).getTime();
        if (!isNaN(start) && !isNaN(end)) durationMs = end - start;
      }

      // Orchestrator role: always 'orchestrator' (subagents get their own virtual sessions)
      const agentRole = 'orchestrator';

      if (hasNewData && sessionId) {
        const existing = db.get('SELECT id FROM sessions WHERE id = ?', [sessionId]);
        if (existing) {
          try {
            db.run(
              `UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
               cache_read = cache_read + ?, cache_creation = cache_creation + ?,
               messages = messages + ?, tool_calls = tool_calls + ?,
               cost = cost + ?, duration_ms = ?, ended_at = COALESCE(?, ended_at),
               model = COALESCE(NULLIF(?, 'unknown'), model),
               project = COALESCE(?, project),
               agent_role = ?
               WHERE id = ?`,
              [tokensIn, tokensOut, cacheRead, cacheCreation, messages, toolCalls, cost,
               durationMs, endedAt, model, project, agentRole, sessionId]
            );
            totalUpdated++;
          } catch (err) {
            console.warn(`[ingest:sessions] Update failed for ${sessionId}:`, err);
          }
        } else {
          try {
            db.run(
              `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, duration_ms, messages, tool_calls, cost, started_at, ended_at, agent_role, parent_session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
              [sessionId, user, project, model, tokensIn, tokensOut, cacheRead, cacheCreation,
               durationMs, messages, toolCalls, cost,
               startedAt ?? new Date().toISOString(), endedAt, agentRole]
            );
            totalInserted++;
          } catch (err) {
            console.warn(`[ingest:sessions] Insert failed for ${sessionId}:`, err);
          }
        }
      }

      db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
    }
  }

  // --- Create virtual sessions for subagents with token data ---
  let subagentInserted = 0;
  for (const entry of subagentEntries) {
    const virtualId = `${entry.session_id}::${entry.agent_id}`;

    // Skip if already ingested
    const existing = db.get('SELECT id FROM sessions WHERE id = ?', [virtualId]);
    if (existing) continue;

    // Look up parent session for user/project context
    const parent = db.get('SELECT user, project, started_at FROM sessions WHERE id = ?', [entry.session_id]);
    const user = (parent?.user as string) ?? 'unknown';
    const project = (parent?.project as string) ?? 'unknown';

    const subCost = Math.max(0, computeCost(pricing, entry.model, entry.tokens_in, entry.tokens_out, entry.cache_read, entry.cache_creation));

    try {
      db.run(
        `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, duration_ms, messages, tool_calls, cost, started_at, ended_at, agent_role, parent_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
        [virtualId, user, project, entry.model, entry.tokens_in, entry.tokens_out, entry.cache_read, entry.cache_creation,
         subCost, entry.timestamp, entry.timestamp, entry.agent_type, entry.session_id]
      );
      subagentInserted++;
    } catch (err) {
      console.warn(`[ingest:sessions] Subagent insert failed for ${virtualId}:`, err);
    }
  }

  if (totalInserted > 0 || totalUpdated > 0) {
    console.log(`[ingest:sessions] Inserted ${totalInserted}, updated ${totalUpdated} session records`);
  }
  if (subagentInserted > 0) {
    console.log(`[ingest:sessions] Created ${subagentInserted} subagent virtual sessions`);
  }
}
