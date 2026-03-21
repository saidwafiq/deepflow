import type { DbHelpers } from '../../db/index.js';
/**
 * Parses ~/.claude/tool-usage.jsonl → tool_usage table.
 */
export declare function parseToolUsage(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=tool-usage.d.ts.map