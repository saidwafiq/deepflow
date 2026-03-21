import type { DbHelpers } from '../../db/index.js';
/**
 * Parses execution-history.jsonl files → task_attempts table.
 * Correlates task_start/task_end pairs by task_id + session_id.
 * Joins token_events within the task's timestamp window to compute token totals.
 */
export declare function parseExecutionHistory(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=execution-history.d.ts.map