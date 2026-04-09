import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { QUOTA_WINDOW_KEYS } from '../ingest/parsers/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw snapshot fields for a five_hour / seven_day / seven_day_sonnet window */
export interface QuotaSnapshot {
  timestamp: string;
  type: 'five_hour' | 'seven_day' | 'seven_day_sonnet';
  utilization: number;
  resetsAt: string;
}

/** Raw snapshot fields for an extra_usage window */
export interface ExtraUsageSnapshot {
  timestamp: string;
  isEnabled: boolean;
  usedCredits: number;
  monthlyLimit: number;
  resetsAt: string | null;
}

/** An aggregated quota window for five_hour / seven_day / seven_day_sonnet */
export interface QuotaWindow {
  type: 'five_hour' | 'seven_day' | 'seven_day_sonnet';
  startedAt: string;
  endsAt: string;
  peakUtilization: number;
  finalUtilization: number;
  snapshotCount: number;
}

/** An aggregated quota window for extra_usage */
export interface ExtraUsageWindow {
  type: 'extra_usage';
  startedAt: string;
  endsAt: string;
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  peakUtilization: number;
  finalUtilization: number;
  snapshotCount: number;
}

export type AnyQuotaWindow = QuotaWindow | ExtraUsageWindow;

// ---------------------------------------------------------------------------
// Internal builder state
// ---------------------------------------------------------------------------

interface StandardWindowState {
  type: 'five_hour' | 'seven_day' | 'seven_day_sonnet';
  startedAt: string;
  currentResetsAt: string;
  peakUtilization: number;
  lastUtilization: number;
  lastTimestamp: string;
  snapshotCount: number;
}

interface ExtraUsageWindowState {
  type: 'extra_usage';
  startedAt: string;
  currentResetsAt: string | null;
  isEnabled: boolean;
  peakUtilization: number;
  lastUtilization: number;
  lastUsedCredits: number;
  lastMonthlyLimit: number;
  lastTimestamp: string;
  snapshotCount: number;
}

type WindowState = StandardWindowState | ExtraUsageWindowState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStandardKey(type: string): type is 'five_hour' | 'seven_day' | 'seven_day_sonnet' {
  return type === 'five_hour' || type === 'seven_day' || type === 'seven_day_sonnet';
}

function flushStandard(state: StandardWindowState): QuotaWindow {
  return {
    type: state.type,
    startedAt: state.startedAt,
    endsAt: state.currentResetsAt,
    peakUtilization: state.peakUtilization,
    finalUtilization: state.lastUtilization,
    snapshotCount: state.snapshotCount,
  };
}

function flushExtraUsage(state: ExtraUsageWindowState): ExtraUsageWindow {
  return {
    type: 'extra_usage',
    startedAt: state.startedAt,
    endsAt: state.currentResetsAt ?? state.lastTimestamp,
    isEnabled: state.isEnabled,
    monthlyLimit: state.lastMonthlyLimit,
    usedCredits: state.lastUsedCredits,
    peakUtilization: state.peakUtilization,
    finalUtilization: state.lastUtilization,
    snapshotCount: state.snapshotCount,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseQuotaWindowsOptions {
  /**
   * REQ-5: Only yield windows whose `endsAt` is >= this date.
   * Windows that end before this date are silently skipped.
   */
  since?: Date;
}

// ---------------------------------------------------------------------------
// Main streaming parser
// ---------------------------------------------------------------------------

/**
 * Parses a quota-history.jsonl file line by line and yields aggregated
 * `QuotaWindow` / `ExtraUsageWindow` objects as window boundaries are detected.
 *
 * REQ-1: Malformed JSON lines are warned to stderr and skipped.
 * REQ-2: Window boundaries detected by `resets_at` change between consecutive
 *         snapshots of the same window type.
 * REQ-3: Yields `QuotaWindow` for five_hour / seven_day / seven_day_sonnet.
 * REQ-4: Yields `ExtraUsageWindow` for extra_usage.
 * REQ-5: When `opts.since` is provided, only yields windows where endsAt >= since.
 */
export async function* parseQuotaWindows(
  filePath: string,
  opts?: ParseQuotaWindowsOptions
): AsyncGenerator<AnyQuotaWindow> {
  const sinceMs = opts?.since instanceof Date ? opts.since.getTime() : undefined;

  /** Returns true if the window should be yielded given the since filter. */
  function passesFilter(window: AnyQuotaWindow): boolean {
    if (sinceMs === undefined) return true;
    return new Date(window.endsAt).getTime() >= sinceMs;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  // Per-type in-progress window state
  const windowStates = new Map<string, WindowState>();

  let lineNumber = 0;

  for await (const rawLine of rl) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;

    // REQ-1: Parse JSON, warn and skip on failure
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(
        `[quota-window-parser] Malformed JSON at line ${lineNumber}, skipping\n`
      );
      continue;
    }

    // Extract timestamp
    const timestamp = (
      record.captured_at ??
      record.capturedAt ??
      record.timestamp ??
      null
    ) as string | null;

    if (typeof timestamp !== 'string' || !timestamp) {
      process.stderr.write(
        `[quota-window-parser] Missing timestamp at line ${lineNumber}, skipping\n`
      );
      continue;
    }

    // Process each known window key
    for (const wk of QUOTA_WINDOW_KEYS) {
      const raw = record[wk];
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;

      if (wk === 'extra_usage') {
        // --- extra_usage window ---
        const isEnabled = Boolean(obj.is_enabled);

        let usedCredits = 0;
        let monthlyLimit = 0;
        let utilization = 0;

        if (isEnabled) {
          usedCredits = typeof obj.used_credits === 'number' ? obj.used_credits / 100 : 0;
          monthlyLimit = typeof obj.monthly_limit === 'number' ? obj.monthly_limit / 100 : 0;
          if (typeof obj.utilization === 'number') {
            utilization = obj.utilization;
          } else {
            utilization = monthlyLimit > 0 ? (usedCredits / monthlyLimit) * 100 : 0;
          }
        }

        const resetsAt = (obj.resets_at as string | null | undefined) ?? null;

        const existing = windowStates.get('extra_usage') as ExtraUsageWindowState | undefined;

        if (!existing) {
          // Start first window
          windowStates.set('extra_usage', {
            type: 'extra_usage',
            startedAt: timestamp,
            currentResetsAt: resetsAt,
            isEnabled,
            peakUtilization: utilization,
            lastUtilization: utilization,
            lastUsedCredits: usedCredits,
            lastMonthlyLimit: monthlyLimit,
            lastTimestamp: timestamp,
            snapshotCount: 1,
          });
        } else {
          // New window when snapshot timestamp has passed the current window's end time
          const boundaryChanged =
            existing.currentResetsAt !== null &&
            new Date(timestamp).getTime() > new Date(existing.currentResetsAt).getTime();

          if (boundaryChanged) {
            // Flush completed window (REQ-5: apply since filter)
            const completed = flushExtraUsage(existing);
            if (passesFilter(completed)) yield completed;

            // Start new window
            windowStates.set('extra_usage', {
              type: 'extra_usage',
              startedAt: timestamp,
              currentResetsAt: resetsAt,
              isEnabled,
              peakUtilization: utilization,
              lastUtilization: utilization,
              lastUsedCredits: usedCredits,
              lastMonthlyLimit: monthlyLimit,
              lastTimestamp: timestamp,
              snapshotCount: 1,
            });
          } else {
            // Continue accumulating in current window
            existing.isEnabled = isEnabled;
            existing.peakUtilization = Math.max(existing.peakUtilization, utilization);
            existing.lastUtilization = utilization;
            existing.lastUsedCredits = usedCredits;
            existing.lastMonthlyLimit = monthlyLimit;
            existing.lastTimestamp = timestamp;
            existing.snapshotCount++;
          }
        }
      } else {
        // --- five_hour / seven_day / seven_day_sonnet window ---
        if (!isStandardKey(wk)) continue;

        // 404 records may be missing utilization/resets_at — skip them
        const utilization = typeof obj.utilization === 'number' ? obj.utilization : null;
        const resetsAt = typeof obj.resets_at === 'string' ? obj.resets_at : null;

        if (utilization === null || resetsAt === null) {
          // Tolerate 404-style records: warn and skip (don't break window continuity)
          process.stderr.write(
            `[quota-window-parser] Missing utilization/resets_at for ${wk} at line ${lineNumber}, skipping snapshot\n`
          );
          continue;
        }

        const existing = windowStates.get(wk) as StandardWindowState | undefined;

        if (!existing) {
          // Start first window
          windowStates.set(wk, {
            type: wk,
            startedAt: timestamp,
            currentResetsAt: resetsAt,
            peakUtilization: utilization,
            lastUtilization: utilization,
            lastTimestamp: timestamp,
            snapshotCount: 1,
          });
        } else {
          // New window when snapshot timestamp has passed the current window's end time
          if (new Date(timestamp).getTime() > new Date(existing.currentResetsAt).getTime()) {
            // Flush completed window (REQ-5: apply since filter)
            const completed = flushStandard(existing);
            if (passesFilter(completed)) yield completed;

            // Start new window
            windowStates.set(wk, {
              type: wk,
              startedAt: timestamp,
              currentResetsAt: resetsAt,
              peakUtilization: utilization,
              lastUtilization: utilization,
              lastTimestamp: timestamp,
              snapshotCount: 1,
            });
          } else {
            // Continue accumulating
            existing.peakUtilization = Math.max(existing.peakUtilization, utilization);
            existing.lastUtilization = utilization;
            existing.lastTimestamp = timestamp;
            existing.snapshotCount++;
          }
        }
      }
    }
  }

  // Flush any open windows at end of file (REQ-5: apply since filter)
  for (const [, state] of windowStates) {
    const flushed: AnyQuotaWindow =
      state.type === 'extra_usage'
        ? flushExtraUsage(state as ExtraUsageWindowState)
        : flushStandard(state as StandardWindowState);
    if (passesFilter(flushed)) yield flushed;
  }
}
