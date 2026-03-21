import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Parses ~/.claude/history.jsonl → command_history table.
 * Each line: { command, timestamp, session_id? }
 */
export async function parseHistory(db, claudeDir) {
    const filePath = resolve(claudeDir, 'history.jsonl');
    if (!existsSync(filePath)) {
        console.warn('[ingest:history] File not found, skipping:', filePath);
        return;
    }
    const offsetKey = 'ingest_offset:history';
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
            console.warn(`[ingest:history] Malformed JSON at line ${i + 1}, skipping`);
            continue;
        }
        try {
            db.run(`INSERT INTO command_history (command, timestamp, session_id) VALUES (?, ?, ?)`, [
                record.command ?? '',
                (record.timestamp ?? record.ts ?? new Date().toISOString()),
                (record.session_id ?? record.sessionId ?? null),
            ]);
            inserted++;
        }
        catch (err) {
            console.warn(`[ingest:history] Insert failed at line ${i + 1}:`, err);
        }
    }
    db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [offsetKey, String(lines.length)]);
    if (inserted > 0)
        console.log(`[ingest:history] Inserted ${inserted} new records`);
}
//# sourceMappingURL=history.js.map