import type { DbHelpers } from '../../db/index.js';
/**
 * Parses token-history.jsonl files from ALL projects → token_events table.
 * Discovers .deepflow/ dirs across all known projects for cross-project coverage.
 */
export declare function parseTokenHistory(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=token-history.d.ts.map