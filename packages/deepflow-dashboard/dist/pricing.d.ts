export interface ModelPricing {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
}
export interface PricingData {
    models: Record<string, ModelPricing>;
    _source?: string;
    _updated?: string;
}
/**
 * Return pricing data, fetching from remote once per process.
 * Falls back to bundled JSON if remote is unreachable.
 */
export declare function fetchPricing(): Promise<PricingData>;
/** Resolve a model string to its pricing entry */
export declare function resolveModelPricing(pricing: PricingData, model: string): ModelPricing | undefined;
/**
 * Compute cost in USD for a token event.
 */
export declare function computeCost(pricing: PricingData, model: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheCreationTokens?: number): number;
//# sourceMappingURL=pricing.d.ts.map