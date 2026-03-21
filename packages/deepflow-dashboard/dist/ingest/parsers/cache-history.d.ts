import type { DbHelpers } from '../../db/index.js';
/**
 * Parses ~/.claude/cache-history.jsonl → token_events (cache-specific rows).
 * Records without a session_id get a synthetic one derived from the timestamp.
 */
export declare function parseCacheHistory(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=cache-history.d.ts.map