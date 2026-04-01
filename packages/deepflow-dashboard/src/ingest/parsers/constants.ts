/**
 * Shared constants for ingest parsers.
 */

/**
 * The four quota window keys present in quota-history.jsonl records.
 * Each key maps to a nested object with used/limit/reset fields.
 */
export const QUOTA_WINDOW_KEYS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'extra_usage'] as const;
