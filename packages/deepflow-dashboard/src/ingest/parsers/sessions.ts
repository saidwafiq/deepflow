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
      let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreation = 0, cacheCreation5m = 0, cacheCreation1h = 0;
      let messages = 0, toolCalls = 0;
      let model = 'unknown', user = 'unknown';
      const project = projectEntry.name;
      let startedAt: string | null = null, endedAt: string | null = null;
      let durationMs = 0;
      let hasNewData = false;

      // Streaming dedup heuristic: track the last-added input-side token values so that when
      // a streaming chunk repeat is detected (input_tokens stays the same or decreases vs. the
      // prior event with usage), we replace the previously-added values with the max, rather than
      // summing duplicates.  output_tokens is always summed (it rarely duplicates).
      let lastInputTokens = -1;
      let lastAddedIn = 0, lastAddedCacheRead = 0, lastAddedCacheCreation = 0;
      let lastAdded5m = 0, lastAdded1h = 0;

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
        const msgUsage = msg?.usage as Record<string, unknown> | undefined;
        const evtUsage = event.usage as Record<string, unknown> | undefined;
        const usage = msgUsage ?? evtUsage;
        if (usage) {
          const inputTokens = (usage.input_tokens as number) ?? 0;
          const outputTokens = (usage.output_tokens as number) ?? 0;
          const cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
          const cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? 0;

          const ccBreakdown = usage.cache_creation as Record<string, number> | undefined;
          const cc5m = (ccBreakdown && typeof ccBreakdown === 'object')
            ? (ccBreakdown.ephemeral_5m_input_tokens ?? 0) : 0;
          const cc1h = (ccBreakdown && typeof ccBreakdown === 'object')
            ? (ccBreakdown.ephemeral_1h_input_tokens ?? 0) : 0;

          // Streaming dedup: when input_tokens stays the same or decreases vs. the prior
          // event with usage, this is a streaming chunk repeat.  Replace the previously-added
          // input-side values with the max of (previously added, current) instead of summing.
          if (lastInputTokens >= 0 && inputTokens <= lastInputTokens) {
            // Undo last-added values and substitute the max
            tokensIn      = tokensIn      - lastAddedIn          + Math.max(lastAddedIn,          inputTokens);
            cacheRead     = cacheRead     - lastAddedCacheRead    + Math.max(lastAddedCacheRead,    cacheReadTokens);
            cacheCreation = cacheCreation - lastAddedCacheCreation + Math.max(lastAddedCacheCreation, cacheCreationTokens);
            cacheCreation5m = cacheCreation5m - lastAdded5m + Math.max(lastAdded5m, cc5m);
            cacheCreation1h = cacheCreation1h - lastAdded1h + Math.max(lastAdded1h, cc1h);

            // Update "last added" to reflect the new max values
            lastAddedIn           = Math.max(lastAddedIn,           inputTokens);
            lastAddedCacheRead    = Math.max(lastAddedCacheRead,    cacheReadTokens);
            lastAddedCacheCreation = Math.max(lastAddedCacheCreation, cacheCreationTokens);
            lastAdded5m           = Math.max(lastAdded5m,           cc5m);
            lastAdded1h           = Math.max(lastAdded1h,           cc1h);
          } else {
            // Real new turn: sum normally for input-side tokens
            tokensIn           += inputTokens;
            cacheRead          += cacheReadTokens;
            cacheCreation      += cacheCreationTokens;
            cacheCreation5m    += cc5m;
            cacheCreation1h    += cc1h;

            // Remember what we added for this turn (for potential future dedup within same turn)
            lastAddedIn            = inputTokens;
            lastAddedCacheRead     = cacheReadTokens;
            lastAddedCacheCreation = cacheCreationTokens;
            lastAdded5m            = cc5m;
            lastAdded1h            = cc1h;
          }

          // output_tokens is always summed (streaming duplicates rarely affect output counts)
          tokensOut += outputTokens;

          // Advance dedup tracker
          lastInputTokens = inputTokens;
        }
      }

      // Orchestrator session: keep original model from event stream (don't override from registry)
      // Clamp accumulated token values to non-negative before cost computation and DB writes
      if (tokensIn < 0) { console.warn(`[ingest:sessions] Clamping negative tokensIn (${tokensIn}) to 0 for session ${sessionId}`); tokensIn = 0; }
      if (tokensOut < 0) { console.warn(`[ingest:sessions] Clamping negative tokensOut (${tokensOut}) to 0 for session ${sessionId}`); tokensOut = 0; }
      if (cacheRead < 0) { console.warn(`[ingest:sessions] Clamping negative cacheRead (${cacheRead}) to 0 for session ${sessionId}`); cacheRead = 0; }
      if (cacheCreation < 0) { console.warn(`[ingest:sessions] Clamping negative cacheCreation (${cacheCreation}) to 0 for session ${sessionId}`); cacheCreation = 0; }
      if (cacheCreation5m < 0) cacheCreation5m = 0;
      if (cacheCreation1h < 0) cacheCreation1h = 0;

      // Compute cost after loop using accumulated tokens + resolved model
      const rawCost = computeCost(pricing, model, tokensIn, tokensOut, cacheRead, cacheCreation5m, cacheCreation1h);
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
               cache_creation_5m = cache_creation_5m + ?, cache_creation_1h = cache_creation_1h + ?,
               messages = messages + ?, tool_calls = tool_calls + ?,
               cost = cost + ?, duration_ms = ?, ended_at = COALESCE(?, ended_at),
               model = COALESCE(NULLIF(?, 'unknown'), model),
               project = COALESCE(?, project),
               agent_role = ?
               WHERE id = ?`,
              [tokensIn, tokensOut, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h,
               messages, toolCalls, cost, durationMs, endedAt, model, project, agentRole, sessionId]
            );
            totalUpdated++;
          } catch (err) {
            console.warn(`[ingest:sessions] Update failed for ${sessionId}:`, err);
          }
        } else {
          try {
            db.run(
              `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cache_creation_5m, cache_creation_1h, duration_ms, messages, tool_calls, cost, started_at, ended_at, agent_role, parent_session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
              [sessionId, user, project, model, tokensIn, tokensOut, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h,
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

    // --- Filesystem scan: ingest subagent JSONL files from {projectDir}/subagents/ ---
    const subagentsDir = join(projectEntry.path, 'subagents');
    if (existsSync(subagentsDir)) {
      let subagentFiles: string[];
      try {
        subagentFiles = readdirSync(subagentsDir)
          .filter((f) => /^agent-[^.]+\.jsonl$/.test(f))
          .map((f) => join(subagentsDir, f));
      } catch {
        subagentFiles = [];
      }

      for (const subFilePath of subagentFiles) {
        // Extract agent hash from filename: agent-{hash}.jsonl
        const subFileBase = basename(subFilePath, '.jsonl');
        const agentIdMatch = subFileBase.match(/^agent-(.+)$/);
        if (!agentIdMatch) continue;
        const agentId = agentIdMatch[1];

        // Read sibling meta.json for session_id (parent), agent_type, model
        const metaPath = join(subagentsDir, `${subFileBase}.meta.json`);
        let parentSessionId: string | null = null;
        let agentType = 'subagent';
        let subMeta: Record<string, unknown> = {};
        if (existsSync(metaPath)) {
          try {
            subMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
            parentSessionId = (subMeta.session_id as string | undefined) ?? null;
            agentType = (subMeta.agent_type as string | undefined) ?? 'subagent';
          } catch {
            // ignore malformed meta
          }
        }

        // Virtual session ID
        const virtualId = parentSessionId
          ? `${parentSessionId}::${agentId}`
          : `fs::${agentId}`;

        const subOffsetKey = `ingest_offset:session:${virtualId}`;
        const subOffsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [subOffsetKey]);
        const subOffset = subOffsetRow ? parseInt(subOffsetRow.value as string, 10) : 0;

        let subLines: string[];
        try {
          subLines = readFileSync(subFilePath, 'utf-8').split('\n');
        } catch (err) {
          console.warn(`[ingest:sessions] Cannot read subagent file ${subFilePath}:`, err);
          continue;
        }

        if (subLines.length <= subOffset) {
          db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [subOffsetKey, String(subLines.length)]);
          continue;
        }

        // Use model from meta if available; will be overridden by event stream
        let subModel = ((subMeta.model as string | undefined) ?? 'unknown').replace(/\[\d+[km]\]$/i, '');
        let subTokensIn = 0, subTokensOut = 0, subCacheRead = 0, subCacheCreation = 0;
        let subCacheCreation5m = 0, subCacheCreation1h = 0;
        let subMessages = 0, subToolCalls = 0;
        let subStartedAt: string | null = null, subEndedAt: string | null = null;
        let subUser = 'unknown';
        let subHasNewData = false;

        // Streaming dedup heuristic (same as orchestrator)
        let subLastInputTokens = -1;
        let subLastAddedIn = 0, subLastAddedCacheRead = 0, subLastAddedCacheCreation = 0;
        let subLastAdded5m = 0, subLastAdded1h = 0;

        for (let i = subOffset; i < subLines.length; i++) {
          const line = subLines[i].trim();
          if (!line) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          subHasNewData = true;

          if (!subStartedAt && event.timestamp) subStartedAt = event.timestamp as string;
          if (event.timestamp) subEndedAt = event.timestamp as string;
          if (event.user) subUser = event.user as string;

          const msg = event.message as Record<string, unknown> | undefined;
          const msgModel = msg?.model as string | undefined;
          const evtModel = event.model as string | undefined;
          const resolvedModel = msgModel ?? evtModel;
          if (resolvedModel && resolvedModel !== 'unknown') {
            subModel = resolvedModel.replace(/\[\d+[km]\]$/i, '');
          }

          const eventType = event.type as string | undefined;
          if (eventType === 'assistant' || event.role === 'assistant') subMessages++;
          if (eventType === 'user' || eventType === 'human' || event.role === 'human' || event.role === 'user') subMessages++;

          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b.type === 'tool_use') subToolCalls++;
            }
          }

          const msgUsage = msg?.usage as Record<string, unknown> | undefined;
          const evtUsage = event.usage as Record<string, unknown> | undefined;
          const usage = msgUsage ?? evtUsage;
          if (usage) {
            const inputTokens = (usage.input_tokens as number) ?? 0;
            const outputTokens = (usage.output_tokens as number) ?? 0;
            const cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
            const cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? 0;

            const ccBreakdown = usage.cache_creation as Record<string, number> | undefined;
            const cc5m = (ccBreakdown && typeof ccBreakdown === 'object')
              ? (ccBreakdown.ephemeral_5m_input_tokens ?? 0) : 0;
            const cc1h = (ccBreakdown && typeof ccBreakdown === 'object')
              ? (ccBreakdown.ephemeral_1h_input_tokens ?? 0) : 0;

            if (subLastInputTokens >= 0 && inputTokens <= subLastInputTokens) {
              subTokensIn        = subTokensIn        - subLastAddedIn            + Math.max(subLastAddedIn,           inputTokens);
              subCacheRead       = subCacheRead       - subLastAddedCacheRead      + Math.max(subLastAddedCacheRead,    cacheReadTokens);
              subCacheCreation   = subCacheCreation   - subLastAddedCacheCreation  + Math.max(subLastAddedCacheCreation, cacheCreationTokens);
              subCacheCreation5m = subCacheCreation5m - subLastAdded5m             + Math.max(subLastAdded5m,           cc5m);
              subCacheCreation1h = subCacheCreation1h - subLastAdded1h             + Math.max(subLastAdded1h,           cc1h);

              subLastAddedIn            = Math.max(subLastAddedIn,           inputTokens);
              subLastAddedCacheRead     = Math.max(subLastAddedCacheRead,    cacheReadTokens);
              subLastAddedCacheCreation = Math.max(subLastAddedCacheCreation, cacheCreationTokens);
              subLastAdded5m            = Math.max(subLastAdded5m,           cc5m);
              subLastAdded1h            = Math.max(subLastAdded1h,           cc1h);
            } else {
              subTokensIn           += inputTokens;
              subCacheRead          += cacheReadTokens;
              subCacheCreation      += cacheCreationTokens;
              subCacheCreation5m    += cc5m;
              subCacheCreation1h    += cc1h;

              subLastAddedIn            = inputTokens;
              subLastAddedCacheRead     = cacheReadTokens;
              subLastAddedCacheCreation = cacheCreationTokens;
              subLastAdded5m            = cc5m;
              subLastAdded1h            = cc1h;
            }

            subTokensOut += outputTokens;
            subLastInputTokens = inputTokens;
          }
        }

        // Clamp to non-negative
        if (subTokensIn < 0) subTokensIn = 0;
        if (subTokensOut < 0) subTokensOut = 0;
        if (subCacheRead < 0) subCacheRead = 0;
        if (subCacheCreation < 0) subCacheCreation = 0;
        if (subCacheCreation5m < 0) subCacheCreation5m = 0;
        if (subCacheCreation1h < 0) subCacheCreation1h = 0;

        // T4: 5m/1h breakdown extracted above from usage.cache_creation object; passed here correctly
        const rawSubCost = computeCost(pricing, subModel, subTokensIn, subTokensOut, subCacheRead, subCacheCreation5m, subCacheCreation1h);
        const subCost = Math.max(0, rawSubCost);

        let subDurationMs = 0;
        if (subStartedAt && subEndedAt) {
          const start = new Date(subStartedAt).getTime();
          const end = new Date(subEndedAt).getTime();
          if (!isNaN(start) && !isNaN(end)) subDurationMs = end - start;
        }

        // Fall back to parent session for user/project context if not found in events
        if (subUser === 'unknown' && parentSessionId) {
          const parent = db.get('SELECT user, project FROM sessions WHERE id = ?', [parentSessionId]);
          if (parent?.user) subUser = parent.user as string;
        }
        const subProject = (() => {
          if (parentSessionId) {
            const parent = db.get('SELECT project FROM sessions WHERE id = ?', [parentSessionId]);
            if (parent?.project) return parent.project as string;
          }
          return projectEntry.name;
        })();

        if (subHasNewData) {
          const existing = db.get('SELECT id FROM sessions WHERE id = ?', [virtualId]);
          if (existing) {
            try {
              db.run(
                `UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
                 cache_read = cache_read + ?, cache_creation = cache_creation + ?,
                 cache_creation_5m = cache_creation_5m + ?, cache_creation_1h = cache_creation_1h + ?,
                 messages = messages + ?, tool_calls = tool_calls + ?,
                 cost = cost + ?, duration_ms = ?, ended_at = COALESCE(?, ended_at),
                 model = COALESCE(NULLIF(?, 'unknown'), model),
                 agent_role = ?, parent_session_id = COALESCE(parent_session_id, ?)
                 WHERE id = ?`,
                [subTokensIn, subTokensOut, subCacheRead, subCacheCreation, subCacheCreation5m, subCacheCreation1h,
                 subMessages, subToolCalls, subCost, subDurationMs, subEndedAt,
                 subModel, agentType, parentSessionId, virtualId]
              );
              totalUpdated++;
            } catch (err) {
              console.warn(`[ingest:sessions] Subagent FS update failed for ${virtualId}:`, err);
            }
          } else {
            try {
              db.run(
                `INSERT INTO sessions (id, user, project, model, tokens_in, tokens_out, cache_read, cache_creation, cache_creation_5m, cache_creation_1h, duration_ms, messages, tool_calls, cost, started_at, ended_at, agent_role, parent_session_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [virtualId, subUser, subProject, subModel, subTokensIn, subTokensOut, subCacheRead, subCacheCreation,
                 subCacheCreation5m, subCacheCreation1h, subDurationMs, subMessages, subToolCalls, subCost,
                 subStartedAt ?? new Date().toISOString(), subEndedAt, agentType, parentSessionId]
              );
              totalInserted++;
            } catch (err) {
              console.warn(`[ingest:sessions] Subagent FS insert failed for ${virtualId}:`, err);
            }
          }
        }

        db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [subOffsetKey, String(subLines.length)]);
      }
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

    // Subagent entries don't have 5m/1h breakdown — treat all as 5m (conservative)
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
