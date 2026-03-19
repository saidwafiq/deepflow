import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Remote URL for the canonical pricing file (raw GitHub)
const REMOTE_PRICING_URL =
  'https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/_client.py';

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
 * Return pricing data, fetching from remote once per process.
 * Falls back to bundled JSON if remote is unreachable.
 */
export async function fetchPricing(): Promise<PricingData> {
  if (cached) return cached;

  const remote = await fetchRemotePricing();
  if (remote) {
    console.log('[pricing] Loaded from remote');
    cached = remote;
  } else {
    console.log('[pricing] Remote unavailable — using bundled fallback');
    cached = loadFallback();
  }

  return cached;
}

/**
 * Compute cost in USD for a token event.
 * @param model  Model ID string
 * @param inputTokens  Raw input tokens
 * @param outputTokens  Raw output tokens
 * @param cacheReadTokens  Tokens served from cache (cheaper)
 * @param cacheCreationTokens  Tokens written to cache (slightly more expensive)
 */
export function computeCost(
  pricing: PricingData,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0
): number {
  const p = pricing.models[model];
  if (!p) return 0;

  const M = 1_000_000;
  return (
    (inputTokens * p.input) / M +
    (outputTokens * p.output) / M +
    (cacheReadTokens * p.cache_read) / M +
    (cacheCreationTokens * p.cache_creation) / M
  );
}
