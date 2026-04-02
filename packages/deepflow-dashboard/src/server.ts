import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { initDatabase, persistDatabase } from './db/index.js';
import { fetchPricing } from './pricing.js';
import { runIngestion } from './ingest/index.js';
import { createApiRouter } from './api/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  mode: 'local' | 'serve';
  port: number;
}

/** Open the system browser at a URL (best-effort, non-blocking) */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {}); // ignore errors
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const { mode, port } = opts;

  // Init database and pricing concurrently
  const [, pricing] = await Promise.all([
    initDatabase(mode),
    fetchPricing(),
  ]);

  // Run local ingestion on startup (local mode only)
  if (mode === 'local') {
    await runIngestion();
    persistDatabase();
    console.log('[server] Database persisted to disk after ingestion');

    // Re-ingest periodically so dashboard stays fresh
    setInterval(async () => {
      try {
        await runIngestion();
        persistDatabase();
      } catch (err) {
        console.warn('[server] Periodic re-ingestion failed:', err);
      }
    }, 60_000);
  }

  console.log(`[server] Pricing loaded: ${Object.keys(pricing.models).length} models`);

  const app = new Hono();

  // --- Health ---
  app.get('/api/health', (c) =>
    c.json({ status: 'ok', mode, ts: new Date().toISOString() })
  );

  // --- Dashboard API routes (ingest route enabled in serve mode) ---
  app.route('/api', createApiRouter({ mode }));

  // --- SPA static serving ---
  const distPath = resolve(__dirname, '../dist/client');

  if (existsSync(distPath)) {
    // Serve built assets
    app.use(
      '/assets/*',
      serveStatic({ root: resolve(distPath, 'assets'), rewriteRequestPath: (p) => p.replace('/assets', '') })
    );

    // Catch-all: return index.html for client-side routing
    app.get('*', async (c) => {
      const { readFileSync } = await import('node:fs');
      const html = readFileSync(resolve(distPath, 'index.html'), 'utf-8');
      return c.html(html);
    });
  } else {
    // Dev fallback — no build present
    app.get('/', (c) =>
      c.html(`
        <html>
          <body>
            <h2>deepflow-dashboard (${mode} mode)</h2>
            <p>No client build found. Run <code>npm run build</code> first.</p>
            <p>API health: <a href="/api/health">/api/health</a></p>
          </body>
        </html>
      `)
    );
  }

  const url = `http://localhost:${port}`;
  console.log(`[deepflow-dashboard] Starting in ${mode} mode on ${url}`);

  serve({ fetch: app.fetch, port }, () => {
    console.log(`[deepflow-dashboard] Ready → ${url}`);
    if (mode === 'local') {
      openBrowser(url);
    }
  });
}
