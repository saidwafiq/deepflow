#!/usr/bin/env node
/**
 * @file artifact-paths.js
 * @description Single source of truth for artifact filenames in the 5-artifact chain.
 *
 * Consumed by:
 *   - hooks/df-artifact-validate.js         (validation hook)
 *   - hooks/lib/artifact-predicates.js      (shared predicates)
 *   - Any future hook or command needing artifact filename constants
 *
 * Integration contract (specs/artifact-validation.md#AC-1):
 *   - SKETCH, IMPACT, FINDINGS, PLAN, VERIFY_RESULT constants
 *   - Object.freeze() enforces immutability
 *   - No string literals for these filenames allowed in consuming modules
 */

'use strict';

/**
 * Canonical artifact filenames for the 5-artifact chain.
 * These map to files under .deepflow/maps/{spec}/ or at repo root (PLAN.md).
 *
 * @constant
 * @type {{SKETCH: string, IMPACT: string, FINDINGS: string, PLAN: string, VERIFY_RESULT: string}}
 */
module.exports = Object.freeze({
  SKETCH: 'sketch.md',
  IMPACT: 'impact.md',
  FINDINGS: 'findings.md',
  PLAN: 'PLAN.md',
  VERIFY_RESULT: 'verify-result.json',
});
