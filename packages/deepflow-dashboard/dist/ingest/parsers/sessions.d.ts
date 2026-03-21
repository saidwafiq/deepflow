import type { DbHelpers } from '../../db/index.js';
/**
 * Parses per-session JSONL files in ~/.claude/projects/{project}/ → sessions table.
 * Session files are UUID-named .jsonl files directly in each project directory.
 * Each file is a stream of events; we materialise a session row from the aggregate.
 *
 * Event structure (Claude Code JSONL format):
 *   - event.type: 'user' | 'assistant' | 'system' | 'summary'
 *   - event.message: { role, model, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }, content: [...] }
 *   - event.message.content[]: blocks with type 'tool_use' | 'tool_result' | 'text'
 *   - event.model / event.usage: fallback fields (older format)
 */
export declare function parseSessions(db: DbHelpers, claudeDir: string): Promise<void>;
//# sourceMappingURL=sessions.d.ts.map