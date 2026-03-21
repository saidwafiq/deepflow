import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Parses ~/.claude/quota-history.jsonl → quota_snapshots table.
 * Offset tracks number of lines already processed.
 */
export async function parseQuotaHistory(db, claudeDir) {
    const filePath = resolve(claudeDir, 'quota-history.jsonl');
    if (!existsSync(filePath)) {
        console.warn('[ingest:quota-history] File not found, skipping:', filePath);
        return;
    }
    const offsetKey = 'ingest_offset:quota-history';
    const offsetRow = db.get('SELECT value FROM _meta WHERE key = ?', [offsetKey]);
    const offset = offsetRow ? parseInt(offsetRow.value, 10) : 0;
    const lines = readFileSync(filePath, 'utf-8').split('\n');
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
            console.warn(`[ingest:quota-history] Malformed JSON at line ${i + 1}, skipping`);
            continue;
        }
        const ts = (record.captured_at ?? record.capturedAt ?? record.timestamp ?? new Date().toISOString());
        const user = record.user ?? 'unknown';
        // Quota JSONL has nested window objects: five_hour, seven_day, seven_day_sonnet, extra_usage
        const windows = [];
        const windowKeys = ['five_hour', 'seven_day', 'seven_day_sonnet', 'extra_usage'];
        for (const wk of windowKeys) {
            if (record[wk] && typeof record[wk] === 'object') {
                windows.push({ type: wk, obj: record[wk] });
            }
        }
        // If no nested windows found, fall back to flat format
        if (windows.length === 0) {
            windows.push({
                type: record.window_type ?? record.windowType ?? 'unknown',
                obj: record,
            });
        }
        for (const w of windows) {
            try {
                const used = (w.obj.used_credits ?? w.obj.used ?? w.obj.utilization ?? 0);
                const limitVal = (w.obj.monthly_limit ?? w.obj.limit ?? w.obj.limit_val ?? null);
                const resetAt = (w.obj.resets_at ?? w.obj.reset_at ?? null);
                db.run(`INSERT INTO quota_snapshots (user, window_type, used, limit_val, reset_at, captured_at)
           VALUES (?, ?, ?, ?, ?, ?)`, [user, w.type, used, limitVal, resetAt, ts]);
                inserted++;
            }
            catch (err) {
                console.warn(`[ingest:quota-history] Insert failed at line ${i + 1} (${w.type}):`, err);
            }
        }
    }
    // Update offset to total line count (including blanks — stable position)
    db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
    if (inserted > 0)
        console.log(`[ingest:quota-history] Inserted ${inserted} new records`);
}
//# sourceMappingURL=quota-history.js.map