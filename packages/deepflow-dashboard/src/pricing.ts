import { createRequire } from 'node:module';

// We maintain our own canonical pricing JSON; fall back to bundled copy.
const PRICING_REMOTE_URL =
  'https://raw.githubusercontent.com/nicholasgasior/anthropic-pricing/main/pricing.json';

export interface ModelPricing {
  input: number;         // USD per 1M tokens
  output: number;        // USD per 1M tokens
  cache_read: number;    // USD per 1M tokens
  cache_creation: number; // USD per 1M tokens
}

export interface PricingData {
  models: Record<string, ModelPricing>;
  _source?: string;
  _updated?: string;
}

let cached: PricingData | null = null;
let cachedAt = 0;

/** TTL for the pricing cache: 1 hour. Exported for testability (mock-clock tests). */
export const PRICING_TTL_MS = 3_600_000;

function loadFallback(): PricingData {
  // Use createRequire to load JSON in ESM context
  const require = createRequire(import.meta.url);
  return require('./data/pricing-fallback.json') as PricingData;
}

/** Fetch pricing from remote; returns null on failure */
async function fetchRemotePricing(): Promise<PricingData | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(PRICING_REMOTE_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json();
    // Validate minimal shape
    if (typeof json === 'object' && json !== null && 'models' in json) {
      return json as PricingData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return pricing data, refreshing after PRICING_TTL_MS.
 * On TTL expiry, attempts remote refetch; falls back to stale cache on failure.
 * Falls back to bundled JSON if no cache exists and remote is unreachable.
 */
export async function fetchPricing(): Promise<PricingData> {
  const now = Date.now();
  if (cached && now - cachedAt <= PRICING_TTL_MS) return cached;

  if (cached) {
    // TTL expired — attempt refresh; keep stale on failure
    const remote = await fetchRemotePricing();
    if (remote) {
      console.log('[pricing] Cache refreshed from remote');
      cached = remote;
      cachedAt = now;
    } else {
      console.log('[pricing] Remote unavailable — keeping stale cache');
      cachedAt = now; // reset TTL to avoid hammering on every call
    }
    return cached;
  }

  // Cold start
  const remote = await fetchRemotePricing();
  if (remote) {
    console.log('[pricing] Loaded from remote');
    cached = remote;
  } else {
    console.log('[pricing] Remote unavailable — using bundled fallback');
    cached = loadFallback();
  }
  cachedAt = now;

  return cached;
}

/** Model alias map: Claude Code model IDs → pricing model IDs */
const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-6[1m]': 'claude-opus-4-20250514',
  'claude-opus-4-6': 'claude-opus-4-20250514',
  'claude-sonnet-4-6[1m]': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250514',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

/** Resolve a model string to its pricing entry */
export function resolveModelPricing(pricing: PricingData, model: string): ModelPricing | undefined {
  // Direct match
  if (pricing.models[model]) return pricing.models[model];
  // Alias match
  const alias = MODEL_ALIASES[model];
  if (alias && pricing.models[alias]) return pricing.models[alias];
  // Fuzzy: strip version suffix and context window markers
  const base = model.replace(/\[\d+[km]\]$/i, '').replace(/-\d{8}$/, '');
  for (const [key, val] of Object.entries(pricing.models)) {
    const keyBase = key.replace(/-\d{8}$/, '');
    if (keyBase === base) return val;
  }
  console.warn(`[pricing] No pricing found for model: ${model}`);
  return undefined;
}

/**
 * Compute cost in USD for a token event.
 */
export function computeCost(
  pricing: PricingData,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0
): number {
  const p = resolveModelPricing(pricing, model);
  if (!p) return 0;

  const M = 1_000_000;
  return (
    (inputTokens * p.input) / M +
    (outputTokens * p.output) / M +
    (cacheReadTokens * p.cache_read) / M +
    (cacheCreationTokens * p.cache_creation) / M
  );
}
