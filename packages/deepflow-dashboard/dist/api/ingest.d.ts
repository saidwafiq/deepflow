import { Hono } from 'hono';
export interface IngestPayload {
    user: string;
    project: string;
    tokens: Record<string, {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_creation?: number;
    }>;
    session_id?: string;
    model?: string;
    started_at?: string;
    ended_at?: string;
    duration_ms?: number;
    messages?: number;
    tool_calls?: number;
    cost?: number;
}
/** POST /api/ingest — team mode only. Accepts single payload or array of payloads. */
export declare function createIngestRouter(): Hono;
//# sourceMappingURL=ingest.d.ts.map