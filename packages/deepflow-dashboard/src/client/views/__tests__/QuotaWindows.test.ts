/**
 * Source-level component tests for the QuotaStatus (quota-windows) view.
 *
 * AC-1: `/quota` renders new list view — no `StackedAreaChart`, no old `QuotaGauge` grid
 * AC-3: Each row shows period and all 4 inline bars with labels (`5h`, `7d`, `Sonnet`, `Extra`)
 *       and `%` value
 * AC-5: Active row (isActive=true) visually distinct
 * AC-7: No chart library imports in the new view file
 * AC-8: No monetary values rendered
 *
 * Strategy: read the source file and make string-level assertions — same pattern
 * used in src/api/__tests__/quota-windows.test.ts for AC-10.
 *
 * Run with:
 *   node --experimental-strip-types --loader ../../lib/__tests__/ts-loader.mjs \
 *     --test src/client/views/__tests__/QuotaWindows.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = resolve(__dirname, '..', 'QuotaStatus.tsx');
const src = readFileSync(VIEW_PATH, 'utf8');

// ---------------------------------------------------------------------------
// AC-1: No StackedAreaChart and no old QuotaGauge references
// ---------------------------------------------------------------------------

describe('AC-1: no StackedAreaChart or QuotaGauge in view source', () => {
  it('does not reference StackedAreaChart', () => {
    assert.ok(
      !src.includes('StackedAreaChart'),
      'View should not reference StackedAreaChart'
    );
  });

  it('does not reference QuotaGauge', () => {
    assert.ok(
      !src.includes('QuotaGauge'),
      'View should not reference the old QuotaGauge component'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: 4 inline bar labels — 5h, 7d, Sonnet, Extra — and % display
// ---------------------------------------------------------------------------

describe('AC-3: 4 inline bar labels and % value display', () => {
  it('renders label "5h"', () => {
    assert.ok(
      src.includes('"5h"') || src.includes("'5h'") || src.includes('`5h`'),
      'View should render the "5h" label for the five-hour bar'
    );
  });

  it('renders label "7d"', () => {
    assert.ok(
      src.includes('"7d"') || src.includes("'7d'") || src.includes('`7d`'),
      'View should render the "7d" label for the seven-day bar'
    );
  });

  it('renders label "Sonnet"', () => {
    assert.ok(
      src.includes('"Sonnet"') || src.includes("'Sonnet'") || src.includes('`Sonnet`'),
      'View should render the "Sonnet" label for the seven-day-sonnet bar'
    );
  });

  it('renders label "Extra"', () => {
    assert.ok(
      src.includes('"Extra"') || src.includes("'Extra'") || src.includes('`Extra`'),
      'View should render the "Extra" label for the extra-usage bar'
    );
  });

  it('formats pct values with % sign', () => {
    // The display expression should produce a "%" character for non-null values
    assert.ok(
      src.includes('%}') || src.includes("'%'") || src.includes('`${') && src.includes('%`'),
      'View should format percentage values with a % sign'
    );
  });

  it('shows period via fmtDate arrow (→)', () => {
    assert.ok(
      src.includes('→'),
      'View should display startedAt → endsAt period label'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5: Active row visually distinct (isActive-based conditional styling)
// ---------------------------------------------------------------------------

describe('AC-5: active row (isActive=true) is visually distinct', () => {
  it('applies different background when isActive is true', () => {
    // The row container must branch on row.isActive for background
    assert.ok(
      src.includes('row.isActive'),
      'View should use row.isActive for conditional styling'
    );
  });

  it('applies different border when isActive is true', () => {
    // There should be an isActive-based ternary for both background and border
    const isActiveOccurrences = (src.match(/row\.isActive/g) || []).length;
    assert.ok(
      isActiveOccurrences >= 2,
      `View should branch on row.isActive at least twice (background + border), found ${isActiveOccurrences}`
    );
  });

  it('renders an "active" badge/label for the active row', () => {
    assert.ok(
      src.includes('active'),
      'View should render a visible "active" marker for the active row'
    );
  });

  it('conditionally renders the active badge only when row.isActive', () => {
    // Expect pattern like: {row.isActive && ( ... 'active' ... )}
    assert.ok(
      src.includes('row.isActive &&'),
      'View should conditionally render the active badge using row.isActive &&'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7: No chart library imports (recharts or other chart libs)
// ---------------------------------------------------------------------------

describe('AC-7: no chart library imports in view file', () => {
  it('does not import from recharts', () => {
    assert.ok(
      !src.includes("from 'recharts'") && !src.includes('from "recharts"'),
      'View should not import from recharts'
    );
  });

  it('does not import from d3', () => {
    assert.ok(
      !src.includes("from 'd3'") && !src.includes('from "d3"'),
      'View should not import from d3'
    );
  });

  it('does not import from chart.js or react-chartjs-2', () => {
    assert.ok(
      !src.includes('chart.js') && !src.includes('react-chartjs'),
      'View should not import from chart.js or react-chartjs-2'
    );
  });

  it('does not import AreaChart, LineChart, or BarChart components', () => {
    assert.ok(
      !src.includes('AreaChart') &&
        !src.includes('LineChart') &&
        !src.includes('BarChart'),
      'View should not reference any chart wrapper components from a chart library'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-8: No monetary values ($, cents, credits)
// ---------------------------------------------------------------------------

describe('AC-8: no monetary values in view source', () => {
  it('does not render $ sign', () => {
    // Template literal ${...} is fine — check for literal $ in JSX/string context
    // We look for '$' as a standalone currency indicator, not template expression
    const dollarSignInJsx = /[^{`](\$)[^{`]/g;
    const matches = src.match(dollarSignInJsx) || [];
    // Filter to only matches that look like currency (not template literal syntax)
    const currencyMatches = matches.filter(
      (m) => !m.includes('${') && !m.includes('`$')
    );
    assert.equal(
      currencyMatches.length,
      0,
      `View should not render $ currency sign; found: ${JSON.stringify(currencyMatches)}`
    );
  });

  it('does not reference "cents"', () => {
    assert.ok(
      !src.toLowerCase().includes('cents'),
      'View should not reference cents'
    );
  });

  it('does not reference "credits"', () => {
    assert.ok(
      !src.toLowerCase().includes('credits'),
      'View should not reference credits (monetary)'
    );
  });

  it('does not reference "cost" or "price"', () => {
    assert.ok(
      !src.toLowerCase().includes('cost') && !src.toLowerCase().includes('price'),
      'View should not reference cost or price values'
    );
  });
});

// ---------------------------------------------------------------------------
// AC-6 (incidental): usePolling is wired
// ---------------------------------------------------------------------------

describe('AC-6 (incidental): usePolling is wired in view', () => {
  it('imports usePolling', () => {
    assert.ok(
      src.includes('usePolling'),
      'View should import and use usePolling for auto-refresh'
    );
  });

  it('calls usePolling(load, refreshInterval)', () => {
    assert.ok(
      src.includes('usePolling(load,') || src.includes('usePolling(load ,'),
      'View should call usePolling with the load callback and refreshInterval'
    );
  });
});
