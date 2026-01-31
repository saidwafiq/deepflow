#!/usr/bin/env node
/**
 * deepflow update checker
 * Runs in background, checks npm for newer versions
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_NAME = 'deepflow';
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'df-update-check.json');

// If called directly, spawn background process and exit
if (process.argv[2] !== '--background') {
  const child = spawn(process.execPath, [__filename, '--background'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  process.exit(0);
}

// Background process
async function checkForUpdate() {
  try {
    // Ensure cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    // Get current version
    const currentVersion = getCurrentVersion();
    if (!currentVersion) {
      process.exit(0);
    }

    // Get latest version from npm (with timeout)
    const latestVersion = await getLatestVersion();
    if (!latestVersion) {
      process.exit(0);
    }

    // Compare and cache result
    const updateAvailable = isNewerVersion(latestVersion, currentVersion);

    const result = {
      updateAvailable,
      currentVersion,
      latestVersion,
      timestamp: Date.now()
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));

  } catch (e) {
    // Fail silently
  }

  process.exit(0);
}

function getCurrentVersion() {
  // Read current version from cache (written by installer)
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cache.currentVersion) {
        return cache.currentVersion;
      }
    } catch (e) {
      // Fall through
    }
  }
  return null;
}

function getLatestVersion() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);

    const child = spawn('npm', ['view', PACKAGE_NAME, 'version'], {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    let output = '';
    child.stdout.on('data', data => output += data);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

function isNewerVersion(latest, current) {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if ((latestParts[i] || 0) > (currentParts[i] || 0)) return true;
    if ((latestParts[i] || 0) < (currentParts[i] || 0)) return false;
  }

  return false;
}

checkForUpdate();
