import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
/**
 * Discover all .deepflow/token-history.jsonl files across projects.
 * Scans common project locations and the Claude projects dir to map back.
 */
function discoverTokenHistoryFiles(claudeDir) {
    const results = [];
    const projectsDir = resolve(claudeDir, 'projects');
    if (!existsSync(projectsDir))
        return results;
    try {
        const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        for (const dirName of projectDirs) {
            // Skip worktree dirs for token-history (they share the parent's)
            if (dirName.includes('--'))
                continue;
            // Decode dir name to real path: "-Users-saidsalles-apps-foo" → "/Users/saidsalles/apps/foo"
            const realPath = '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
            const tokenFile = resolve(realPath, '.deepflow', 'token-history.jsonl');
            if (existsSync(tokenFile)) {
                // Extract project name from path
                const segments = realPath.split('/');
                const appsIdx = segments.lastIndexOf('apps');
                const project = appsIdx >= 0 && appsIdx < segments.length - 1
                    ? segments.slice(appsIdx + 1).join('-')
                    : basename(realPath);
                results.push({ path: tokenFile, project });
            }
        }
    }
    catch {
        // Non-fatal
    }
    return results;
}
/**
 * Parses token-history.jsonl files from ALL projects → token_events table.
 * Discovers .deepflow/ dirs across all known projects for cross-project coverage.
 */
export async function parseTokenHistory(db, claudeDir) {
    const files = discoverTokenHistoryFiles(claudeDir);
    if (files.length === 0) {
        console.warn('[ingest:token-history] No token-history.jsonl files found');
        return;
    }
    let totalInserted = 0;
    for (const { path: filePath, project } of files) {
        const offsetKey = `ingest_offset:token-history:${filePath}`;
        const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
        const offset = offsetRow ? parseInt(offsetRow.value, 10) : 0;
        let lines;
        try {
            lines = readFileSync(filePath, 'utf-8').split('\n');
        }
        catch (err) {
            console.warn(`[ingest:token-history] Cannot read ${filePath}:`, err);
            continue;
        }
        if (lines.length <= offset)
            continue;
        let inserted = 0;
        for (let i = offset; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line)
                continue;
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            const sessionId = (record.session_id ?? record.sessionId);
            if (!sessionId)
                continue;
            // Ensure session row exists with project info
            const existing = db.get('SELECT id FROM sessions WHERE id = ?', [sessionId]);
            if (!existing) {
                try {
                    db.run(`INSERT OR IGNORE INTO sessions (id, user, project, tokens_in, tokens_out, cache_read, cache_creation, messages, tool_calls, cost, started_at)
             VALUES (?, 'unknown', ?, 0, 0, 0, 0, 0, 0, 0, ?)`, [sessionId, project, (record.timestamp ?? new Date().toISOString())]);
                }
                catch {
                    // non-fatal
                }
            }
            try {
                const rawInputTokens = (record.input_tokens ?? record.inputTokens ?? 0);
                const rawOutputTokens = (record.output_tokens ?? record.outputTokens ?? 0);
                const rawCacheRead = (record.cache_read_input_tokens ?? record.cache_read_tokens ?? record.cacheReadTokens ?? 0);
                const rawCacheCreation = (record.cache_creation_input_tokens ?? record.cache_creation_tokens ?? record.cacheCreationTokens ?? 0);
                const clampedInputTokens = Math.max(0, rawInputTokens);
                const clampedOutputTokens = Math.max(0, rawOutputTokens);
                const clampedCacheRead = Math.max(0, rawCacheRead);
                const clampedCacheCreation = Math.max(0, rawCacheCreation);
                if (rawInputTokens < 0)
                    console.warn(`[ingest:token-history] Clamping negative input_tokens (${rawInputTokens}) to 0 at line ${i + 1} in ${filePath}`);
                if (rawOutputTokens < 0)
                    console.warn(`[ingest:token-history] Clamping negative output_tokens (${rawOutputTokens}) to 0 at line ${i + 1} in ${filePath}`);
                if (rawCacheRead < 0)
                    console.warn(`[ingest:token-history] Clamping negative cache_read_tokens (${rawCacheRead}) to 0 at line ${i + 1} in ${filePath}`);
                if (rawCacheCreation < 0)
                    console.warn(`[ingest:token-history] Clamping negative cache_creation_tokens (${rawCacheCreation}) to 0 at line ${i + 1} in ${filePath}`);
                db.run(`INSERT INTO token_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                    sessionId,
                    (record.model ?? 'unknown').replace(/\[\d+[km]\]$/i, ''),
                    clampedInputTokens,
                    clampedOutputTokens,
                    clampedCacheRead,
                    clampedCacheCreation,
                    (record.timestamp ?? new Date().toISOString()),
                ]);
                inserted++;
            }
            catch (err) {
                console.warn(`[ingest:token-history] Insert failed:`, err);
            }
        }
        db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
        if (inserted > 0) {
            console.log(`[ingest:token-history] ${project}: inserted ${inserted} records`);
            totalInserted += inserted;
        }
    }
    if (totalInserted > 0) {
        console.log(`[ingest:token-history] Total: ${totalInserted} new records across ${files.length} projects`);
    }
}
//# sourceMappingURL=token-history.js.map