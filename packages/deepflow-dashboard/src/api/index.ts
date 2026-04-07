import { Hono } from 'hono';
import { sessionsRouter } from './sessions.js';
import { costsRouter } from './costs.js';
import { quotaRouter } from './quota.js';
import { activityRouter } from './activity.js';
import { cacheRouter } from './cache.js';
import { toolsRouter } from './tools.js';
import { createIngestRouter } from './ingest.js';

export interface ApiRouterOptions {
  mode: 'local' | 'serve';
}

/** Mount all dashboard API routes under /api */
export function createApiRouter(opts: ApiRouterOptions = { mode: 'local' }): Hono {
  const api = new Hono();

  api.route('/sessions', sessionsRouter);
  api.route('/costs', costsRouter);
  api.route('/quota', quotaRouter);
  api.route('/activity', activityRouter);
  api.route('/cache', cacheRouter);
  api.route('/tools', toolsRouter);

  // Team mode only: ingestion endpoint
  if (opts.mode === 'serve') {
    api.route('/ingest', createIngestRouter());
  }

  return api;
}
