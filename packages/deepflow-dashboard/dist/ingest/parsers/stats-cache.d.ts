import type { DbHelpers } from '../../db/index.js';
/**
 * Parses ~/.claude/stats-cache.json → sessions table (summary data).
 * stats-cache.json is a JSON object or array of session summaries.
 * Tracked by file size in _meta; re-processed only when the file changes.
 */
export declare function parseStatsCache(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=stats-cache.d.ts.map