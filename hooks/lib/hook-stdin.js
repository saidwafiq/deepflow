'use strict';

/**
 * Shared stdin helper for deepflow hooks.
 *
 * Usage in a hook file:
 *   const { readStdinIfMain } = require('./lib/hook-stdin');
 *   readStdinIfMain(module, (data) => { ... });
 *
 * The helper checks if the CALLING hook is the main module (i.e. run directly,
 * not required by a test). This prevents test files from hanging on stdin.
 */

/**
 * readStdinIfMain(callerModule, callback)
 *
 * @param {NodeModule} callerModule  Pass `module` from the calling hook file.
 * @param {function(Object): void} callback  Called with the parsed JSON payload.
 *   If stdin is not valid JSON the process exits 0 without calling callback.
 */
function readStdinIfMain(callerModule, callback) {
  if (require.main !== callerModule) {
    // Being required (e.g. by a test) — do not read stdin.
    return;
  }

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_e) {
      // Invalid JSON — exit 0 to avoid breaking Claude Code.
      process.exit(0);
    }
    try {
      callback(payload);
    } catch (_e) {
      // Never break Claude Code on hook errors.
    }
    process.exit(0);
  });
}

module.exports = { readStdinIfMain };
