import type { DbHelpers } from '../../db/index.js';
/**
 * Parses ~/.claude/quota-history.jsonl → quota_snapshots table.
 * Offset tracks number of lines already processed.
 */
export declare function parseQuotaHistory(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=quota-history.d.ts.map