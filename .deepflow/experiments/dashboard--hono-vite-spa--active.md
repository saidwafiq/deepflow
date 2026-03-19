# Experiment: Hono + Vite React SPA serving

**Topic**: dashboard
**Hypothesis**: hono-vite-spa
**Status**: active

## Hypothesis

A single Node.js entry point can serve Hono JSON API routes + a Vite-built React SPA from the same port, invocable via `npx`.

## Method

1. Installed hono, @hono/node-server, react, react-dom, vite, @vitejs/plugin-react
2. Created Hono server with `/api/health` route + static file serving + SPA fallback
3. Created minimal React component that fetches `/api/health` and renders result
4. Built SPA with `npx vite build`
5. Started server, tested both endpoints with curl

## Results

| Test | Result | Status |
|------|--------|--------|
| `curl localhost:3333/api/health` returns JSON | `{"status":"ok","timestamp":"..."}` | PASS |
| `curl localhost:3333/` returns React SPA HTML | Full HTML with script tag | PASS |
| Vite build time | 67ms | Excellent |
| Single entry point | `node spike-t10-server.mjs` serves both | PASS |

## Key Findings

1. **Hono + @hono/node-server works perfectly** as a lightweight API + static file server
2. **Vite builds React SPA in 67ms** — pre-build at publish time, serve static at runtime
3. **SPA fallback pattern**: `serveStatic` for `/assets/*`, then catch-all `*` that returns index.html
4. **No Express needed** — Hono is lighter and has native static file serving
5. **npx-invocable**: Single `node server.js` entry point, pre-built SPA in `dist/`

## Verdict

**Hypothesis: CONFIRMED**

Hono + Vite React SPA works cleanly from a single Node.js entry point.
