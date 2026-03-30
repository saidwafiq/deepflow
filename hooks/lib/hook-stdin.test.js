'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { readStdinIfMain } = require('./hook-stdin');

// ---------------------------------------------------------------------------
// 1. Guard: skips stdin when callerModule is NOT require.main
// ---------------------------------------------------------------------------

describe('readStdinIfMain', () => {
  test('returns immediately when callerModule is not require.main', () => {
    const fakeModule = { id: 'not-main' };
    const callback = () => { throw new Error('should not be called'); };

    // Should return undefined without hanging or calling callback
    const result = readStdinIfMain(fakeModule, callback);
    assert.equal(result, undefined);
  });

  test('does not set encoding on stdin when callerModule is not require.main', () => {
    const fakeModule = { id: 'not-main' };
    let encodingSet = false;
    const originalSetEncoding = process.stdin.setEncoding;
    process.stdin.setEncoding = () => { encodingSet = true; };

    try {
      readStdinIfMain(fakeModule, () => {});
      assert.equal(encodingSet, false, 'should not touch stdin when not main');
    } finally {
      process.stdin.setEncoding = originalSetEncoding;
    }
  });

  test('does not attach data listeners when callerModule is not require.main', () => {
    const fakeModule = { id: 'not-main' };
    const listenersBefore = process.stdin.listenerCount('data');

    readStdinIfMain(fakeModule, () => {});

    const listenersAfter = process.stdin.listenerCount('data');
    assert.equal(listenersAfter, listenersBefore, 'should not add data listeners');
  });

  test('callback is never invoked when callerModule is not require.main', () => {
    const fakeModule = { id: 'not-main' };
    let callbackInvoked = false;

    readStdinIfMain(fakeModule, () => { callbackInvoked = true; });
    assert.equal(callbackInvoked, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Module exports
// ---------------------------------------------------------------------------

describe('hook-stdin exports', () => {
  test('exports readStdinIfMain as a function', () => {
    assert.equal(typeof readStdinIfMain, 'function');
  });

  test('readStdinIfMain expects two parameters', () => {
    assert.equal(readStdinIfMain.length, 2);
  });

  test('module exports only readStdinIfMain', () => {
    const exports = require('./hook-stdin');
    const keys = Object.keys(exports);
    assert.deepEqual(keys, ['readStdinIfMain']);
  });
});

// ---------------------------------------------------------------------------
// 3. Integration via subprocess — tests the stdin-reading path
//    Spawns hook-stdin-test-harness as a child process so require.main matches.
// ---------------------------------------------------------------------------

const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// We create a tiny harness script that uses readStdinIfMain with itself as main
const HARNESS_PATH = path.join(__dirname, '_test-harness-stdin.js');

describe('readStdinIfMain when callerModule IS require.main (subprocess)', () => {
  beforeEach(() => {
    // Write a small harness that exercises readStdinIfMain as main module
    fs.writeFileSync(HARNESS_PATH, `
'use strict';
const { readStdinIfMain } = require('./hook-stdin');
readStdinIfMain(module, (data) => {
  // Write parsed payload to stdout so the test can verify
  process.stdout.write(JSON.stringify(data));
});
`);
  });

  afterEach(() => {
    try { fs.unlinkSync(HARNESS_PATH); } catch (_e) { /* ignore */ }
  });

  test('parses valid JSON from stdin and passes to callback', () => {
    const input = JSON.stringify({ event: 'test', foo: 42 });
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
    const parsed = JSON.parse(result);
    assert.deepEqual(parsed, { event: 'test', foo: 42 });
  });

  test('handles empty object from stdin', () => {
    const input = JSON.stringify({});
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.deepEqual(JSON.parse(result), {});
  });

  test('handles array payload from stdin', () => {
    const input = JSON.stringify([1, 2, 3]);
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.deepEqual(JSON.parse(result), [1, 2, 3]);
  });

  test('exits 0 on invalid JSON without calling callback', () => {
    // Invalid JSON should cause process.exit(0) before callback
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input: 'not valid json {{{',
      encoding: 'utf8',
      timeout: 5000,
    });
    // Callback writes to stdout; if not called, stdout should be empty
    assert.equal(result, '');
  });

  test('exits 0 on empty stdin without calling callback', () => {
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result, '');
  });

  test('exits 0 even when callback throws', () => {
    // Write a harness where the callback throws
    const throwHarness = path.join(__dirname, '_test-harness-throw.js');
    fs.writeFileSync(throwHarness, `
'use strict';
const { readStdinIfMain } = require('./hook-stdin');
readStdinIfMain(module, (data) => {
  throw new Error('callback error');
});
`);
    try {
      // Should not throw — the error is caught internally
      execFileSync(process.execPath, [throwHarness], {
        input: JSON.stringify({ ok: true }),
        encoding: 'utf8',
        timeout: 5000,
      });
    } finally {
      try { fs.unlinkSync(throwHarness); } catch (_e) { /* ignore */ }
    }
  });

  test('handles large JSON payload', () => {
    const largeObj = { data: 'x'.repeat(10000), nested: { a: 1 } };
    const input = JSON.stringify(largeObj);
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.data.length, 10000);
    assert.equal(parsed.nested.a, 1);
  });

  test('handles JSON with unicode characters', () => {
    const input = JSON.stringify({ msg: '日本語テスト 🎉' });
    const result = execFileSync(process.execPath, [HARNESS_PATH], {
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.deepEqual(JSON.parse(result), { msg: '日本語テスト 🎉' });
  });
});
