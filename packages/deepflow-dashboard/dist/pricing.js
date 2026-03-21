import { createRequire } from 'node:module';
// We maintain our own canonical pricing JSON; fall back to bundled copy.
const PRICING_REMOTE_URL = 'https://raw.githubusercontent.com/nicholasgasior/anthropic-pricing/main/pricing.json';
let cached = null;
function loadFallback() {
    // Use createRequire to load JSON in ESM context
    const require = createRequire(import.meta.url);
    return require('./data/pricing-fallback.json');
}
/** Fetch pricing from remote; returns null on failure */
async function fetchRemotePricing() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(PRICING_REMOTE_URL, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok)
            return null;
        const json = await res.json();
        // Validate minimal shape
        if (typeof json === 'object' && json !== null && 'models' in json) {
            return json;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Return pricing data, fetching from remote once per process.
 * Falls back to bundled JSON if remote is unreachable.
 */
export async function fetchPricing() {
    if (cached)
        return cached;
    const remote = await fetchRemotePricing();
    if (remote) {
        console.log('[pricing] Loaded from remote');
        cached = remote;
    }
    else {
        console.log('[pricing] Remote unavailable — using bundled fallback');
        cached = loadFallback();
    }
    return cached;
}
/** Model alias map: Claude Code model IDs → pricing model IDs */
const MODEL_ALIASES = {
    'claude-opus-4-6[1m]': 'claude-opus-4-20250514',
    'claude-opus-4-6': 'claude-opus-4-20250514',
    'claude-sonnet-4-6[1m]': 'claude-sonnet-4-20250514',
    'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
    'claude-sonnet-4-5': 'claude-sonnet-4-5-20250514',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};
/** Resolve a model string to its pricing entry */
export function resolveModelPricing(pricing, model) {
    // Direct match
    if (pricing.models[model])
        return pricing.models[model];
    // Alias match
    const alias = MODEL_ALIASES[model];
    if (alias && pricing.models[alias])
        return pricing.models[alias];
    // Fuzzy: strip version suffix and context window markers
    const base = model.replace(/\[\d+[km]\]$/i, '').replace(/-\d{8}$/, '');
    for (const [key, val] of Object.entries(pricing.models)) {
        const keyBase = key.replace(/-\d{8}$/, '');
        if (keyBase === base)
            return val;
    }
    console.warn(`[pricing] No pricing found for model: ${model}`);
    return undefined;
}
/**
 * Compute cost in USD for a token event.
 */
export function computeCost(pricing, model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0) {
    const p = resolveModelPricing(pricing, model);
    if (!p)
        return 0;
    const M = 1_000_000;
    return ((inputTokens * p.input) / M +
        (outputTokens * p.output) / M +
        (cacheReadTokens * p.cache_read) / M +
        (cacheCreationTokens * p.cache_creation) / M);
}
//# sourceMappingURL=pricing.js.map