import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

// API route
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static assets from dist/
app.use('/assets/*', serveStatic({ root: resolve(__dirname, 'dist') }));

// SPA fallback: serve index.html for all non-API routes
app.get('*', (c) => {
  try {
    const html = readFileSync(resolve(__dirname, 'dist', 'spike-t10-index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('dist/spike-t10-index.html not found. Run: npx vite build --config spike-t10-vite.config.js', 404);
  }
});

const port = 3333;
console.log(`Server running at http://localhost:${port}`);

serve({ fetch: app.fetch, port });
