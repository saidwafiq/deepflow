/**
 * Backfill: reads local ~/.claude/ data and POSTs it to a team server.
 * Uses the same parsers as local ingestion, but transforms rows to
 * the /api/ingest payload format instead of writing to a local DB.
 */
export interface BackfillOptions {
    url: string;
    claudeDir?: string;
    deepflowDir?: string;
    user?: string;
}
/** Main backfill entry point. */
export declare function runBackfill(opts: BackfillOptions): Promise<void>;
//# sourceMappingURL=backfill.d.ts.map