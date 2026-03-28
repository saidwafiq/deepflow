const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, 'hooks');

/**
 * Helper: read a file and return its content as a string.
 */
function readFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * Helper: list all non-test hook JS files.
 */
function hookFiles() {
  return fs.readdirSync(HOOKS_DIR)
    .filter(f => f.endsWith('.js') && !f.includes('.test.'));
}

describe('Security Hardening — AC-1: No keychain credential access in hooks', () => {
  test('grep -r "find-generic-password" hooks/ returns zero matches', () => {
    for (const file of hookFiles()) {
      const content = readFile(path.join('hooks', file));
      assert.ok(
        !content.includes('find-generic-password'),
        `hooks/${file} must not contain "find-generic-password"`
      );
    }
  });
});

describe('Security Hardening — AC-2: quota-logger uses anthropic_token config key', () => {
  test('hooks/df-quota-logger.js contains "anthropic_token"', () => {
    const content = readFile('hooks/df-quota-logger.js');
    assert.ok(
      content.includes('anthropic_token'),
      'df-quota-logger.js must reference "anthropic_token"'
    );
  });
});

describe('Security Hardening — AC-3: quota-logger reads user-level config via homedir/HOME', () => {
  test('hooks/df-quota-logger.js contains "homedir" or "HOME"', () => {
    const content = readFile('hooks/df-quota-logger.js');
    const hasHomedir = content.includes('homedir');
    const hasHOME = content.includes('HOME');
    assert.ok(
      hasHomedir || hasHOME,
      'df-quota-logger.js must reference "homedir" or "HOME" for user-level config'
    );
  });
});

describe('Security Hardening — AC-4: dashboard-push reads user-level config via homedir/HOME', () => {
  test('hooks/df-dashboard-push.js contains "homedir" or "HOME"', () => {
    const content = readFile('hooks/df-dashboard-push.js');
    const hasHomedir = content.includes('homedir');
    const hasHOME = content.includes('HOME');
    assert.ok(
      hasHomedir || hasHOME,
      'df-dashboard-push.js must reference "homedir" or "HOME" for user-level config'
    );
  });
});

describe('Security Hardening — AC-5: config template does not contain dashboard_url', () => {
  test('templates/config-template.yaml does not contain "dashboard_url"', () => {
    const content = readFile('templates/config-template.yaml');
    assert.ok(
      !content.includes('dashboard_url'),
      'config-template.yaml must not contain "dashboard_url"'
    );
  });
});

describe('Security Hardening — AC-6: invariant-check does not use execSync', () => {
  test('hooks/df-invariant-check.js does not contain "execSync"', () => {
    const content = readFile('hooks/df-invariant-check.js');
    assert.ok(
      !content.includes('execSync'),
      'df-invariant-check.js must not use execSync (shell injection risk)'
    );
  });
});

describe('Security Hardening — AC-7: installer checks for symbolic links', () => {
  test('bin/install.js contains "isSymbolicLink"', () => {
    const content = readFile('bin/install.js');
    assert.ok(
      content.includes('isSymbolicLink'),
      'install.js must check for symbolic links to prevent path traversal'
    );
  });
});

describe('Security Hardening — AC-8: no execSync in any hook file', () => {
  test('no hook file (excluding tests) contains "execSync"', () => {
    const violations = [];
    for (const file of hookFiles()) {
      const content = readFile(path.join('hooks', file));
      if (content.includes('execSync')) {
        violations.push(file);
      }
    }
    assert.deepStrictEqual(
      violations,
      [],
      `These hook files still use execSync: ${violations.join(', ')}`
    );
  });
});

describe('Security Hardening — AC-9: quota-logger does not throw at import time', () => {
  test('node -e "require(\'./hooks/df-quota-logger.js\')" succeeds', () => {
    // Use execFileSync to run node with require — any throw will cause a non-zero exit
    const result = execFileSync(
      process.execPath,
      ['-e', `require('${path.join(ROOT, 'hooks', 'df-quota-logger.js').replace(/'/g, "\\'")}');`],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_ENV: 'test' } }
    );
    // If we get here, the require succeeded without throwing
    assert.ok(true, 'df-quota-logger.js imported without throwing');
  });
});
