import { type Database, type SqlValue } from 'sql.js';
/** Persist in-memory DB to disk */
export declare function persistDatabase(): void;
/** Initialize sql.js and open (or create) the database, running schema migrations */
export declare function initDatabase(mode?: 'local' | 'serve'): Promise<Database>;
/** Get the initialized database instance (throws if not initialized) */
export declare function getDb(): Database;
export type Row = Record<string, unknown>;
/** Shared db helper interface passed to ingest parsers */
export interface DbHelpers {
    run: (sql: string, params?: SqlValue[]) => void;
    get: (sql: string, params?: SqlValue[]) => Row | undefined;
    all: (sql: string, params?: SqlValue[]) => Row[];
}
/** Execute a statement with optional bind params (no result rows) */
export declare function run(sql: string, params?: SqlValue[]): void;
/** Return first matching row or undefined */
export declare function get(sql: string, params?: SqlValue[]): Row | undefined;
/** Return all matching rows */
export declare function all(sql: string, params?: SqlValue[]): Row[];
//# sourceMappingURL=index.d.ts.map