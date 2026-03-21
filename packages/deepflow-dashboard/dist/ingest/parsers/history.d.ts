import type { DbHelpers } from '../../db/index.js';
/**
 * Parses ~/.claude/history.jsonl → command_history table.
 * Each line: { command, timestamp, session_id? }
 */
export declare function parseHistory(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=history.d.ts.map