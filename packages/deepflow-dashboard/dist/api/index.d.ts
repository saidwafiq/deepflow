import { Hono } from 'hono';
export interface ApiRouterOptions {
    mode: 'local' | 'serve';
}
/** Mount all dashboard API routes under /api */
export declare function createApiRouter(opts?: ApiRouterOptions): Hono;
//# sourceMappingURL=index.d.ts.map