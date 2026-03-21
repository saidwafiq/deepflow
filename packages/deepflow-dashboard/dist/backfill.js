/**
 * Backfill: reads local ~/.claude/ data and POSTs it to a team server.
 * Uses the same parsers as local ingestion, but transforms rows to
 * the /api/ingest payload format instead of writing to a local DB.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import https from 'node:https';
import http from 'node:http';
const BATCH_SIZE = 100;
/** POST a batch of payloads to the remote server. Returns true on success. */
async function postBatch(url, payloads) {
    return new Promise((resolve) => {
        const body = JSON.stringify(payloads);
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 30000,
        };
        const req = lib.request(options, (res) => {
            // Consume response body to free socket
            res.resume();
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', (err) => {
            console.warn('[backfill] Request error:', err.message);
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.write(body);
        req.end();
    });
}
/** Send payloads in BATCH_SIZE chunks. Returns total successful count. */
async function sendInBatches(url, payloads) {
    let sent = 0;
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
        const batch = payloads.slice(i, i + BATCH_SIZE);
        const ok = await postBatch(url, batch);
        if (ok) {
            sent += batch.length;
            process.stdout.write(`\r[backfill] Sent ${sent}/${payloads.length}`);
        }
        else {
            console.warn(`\n[backfill] Batch ${i / BATCH_SIZE + 1} failed, continuing…`);
        }
    }
    if (payloads.length > 0)
        process.stdout.write('\n');
    return sent;
}
/** Build IngestPayload objects from session JSONL files in ~/.claude/projects/ */
function collectSessionPayloads(claudeDir) {
    const payloads = [];
    const projectsDir = resolve(claudeDir, 'projects');
    if (!existsSync(projectsDir))
        return payloads;
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(projectsDir, d.name));
    for (const projectDir of projectDirs) {
        const sessionsDir = join(projectDir, 'sessions');
        if (!existsSync(sessionsDir))
            continue;
        const sessionFiles = readdirSync(sessionsDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => join(sessionsDir, f));
        for (const filePath of sessionFiles) {
            let lines;
            try {
                lines = readFileSync(filePath, 'utf-8').split('\n');
            }
            catch {
                continue;
            }
            let sessionId = null;
            let user = 'unknown', project = null;
            let model = 'unknown';
            let startedAt = null, endedAt = null;
            let messages = 0, toolCalls = 0, cost = 0, durationMs = null;
            const tokensByModel = {};
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                let event;
                try {
                    event = JSON.parse(trimmed);
                }
                catch {
                    continue;
                }
                if (!sessionId)
                    sessionId = (event.session_id ?? event.sessionId ?? event.id);
                if (!startedAt)
                    startedAt = (event.timestamp ?? event.ts ?? event.started_at ?? null);
                endedAt = (event.timestamp ?? event.ts ?? null);
                if (event.model && event.model !== 'unknown')
                    model = event.model;
                if (event.user)
                    user = event.user;
                if (event.project)
                    project = event.project;
                if (event.duration_ms)
                    durationMs = event.duration_ms;
                const usage = event.usage;
                const evModel = event.model ?? model;
                if (!tokensByModel[evModel])
                    tokensByModel[evModel] = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
                tokensByModel[evModel].input += usage?.input_tokens ?? event.input_tokens ?? 0;
                tokensByModel[evModel].output += usage?.output_tokens ?? event.output_tokens ?? 0;
                tokensByModel[evModel].cache_read += usage?.cache_read_tokens ?? event.cache_read_tokens ?? 0;
                tokensByModel[evModel].cache_creation += usage?.cache_creation_tokens ?? event.cache_creation_tokens ?? 0;
                cost += event.cost ?? 0;
                if (event.type === 'message' || event.role)
                    messages++;
                if (event.type === 'tool_use' || event.tool_name)
                    toolCalls++;
            }
            if (!sessionId || Object.keys(tokensByModel).length === 0)
                continue;
            payloads.push({
                user,
                project: project ?? 'unknown',
                tokens: tokensByModel,
                session_id: sessionId,
                model,
                started_at: startedAt ?? new Date().toISOString(),
                ended_at: endedAt ?? undefined,
                duration_ms: durationMs ?? undefined,
                messages,
                tool_calls: toolCalls,
                cost,
            });
        }
    }
    return payloads;
}
/** Build IngestPayload objects from .deepflow/token-history.jsonl */
function collectTokenHistoryPayloads(deepflowDir, defaultUser) {
    const payloads = [];
    const filePath = resolve(deepflowDir, 'token-history.jsonl');
    if (!existsSync(filePath))
        return payloads;
    let lines;
    try {
        lines = readFileSync(filePath, 'utf-8').split('\n');
    }
    catch {
        return payloads;
    }
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let record;
        try {
            record = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const sessionId = (record.session_id ?? record.sessionId);
        if (!sessionId)
            continue;
        const mdl = record.model ?? 'unknown';
        payloads.push({
            user: defaultUser,
            project: 'unknown',
            tokens: {
                [mdl]: {
                    input: record.input_tokens ?? 0,
                    output: 0,
                    cache_read: record.cache_read_tokens ?? 0,
                    cache_creation: record.cache_creation_tokens ?? 0,
                },
            },
            session_id: sessionId,
            model: mdl,
            started_at: record.timestamp ?? new Date().toISOString(),
        });
    }
    return payloads;
}
/** Main backfill entry point. */
export async function runBackfill(opts) {
    const claudeDir = opts.claudeDir ?? resolve(homedir(), '.claude');
    const deepflowDir = opts.deepflowDir ?? resolve(process.cwd(), '.deepflow');
    const user = opts.user ?? process.env.USER ?? 'unknown';
    const ingestUrl = opts.url.replace(/\/$/, '') + '/api/ingest';
    console.log(`[backfill] Source: ${claudeDir}`);
    console.log(`[backfill] Target: ${ingestUrl}`);
    // Collect from both sources; merge by session_id preference (session files first)
    const sessionPayloads = collectSessionPayloads(claudeDir);
    const tokenPayloads = collectTokenHistoryPayloads(deepflowDir, user);
    // Deduplicate: session payloads take precedence; skip token-history records whose
    // session_id is already covered by a session file payload.
    const seenSessions = new Set(sessionPayloads.map((p) => p.session_id).filter(Boolean));
    const deduped = tokenPayloads.filter((p) => !seenSessions.has(p.session_id));
    const all = [...sessionPayloads, ...deduped];
    console.log(`[backfill] Collected ${all.length} records (${sessionPayloads.length} sessions + ${deduped.length} token-history)`);
    if (all.length === 0) {
        console.log('[backfill] Nothing to send.');
        return;
    }
    const sent = await sendInBatches(ingestUrl, all);
    console.log(`[backfill] Done. Sent ${sent}/${all.length} records.`);
}
//# sourceMappingURL=backfill.js.map