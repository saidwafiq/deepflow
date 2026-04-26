#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class PortPoolManager {
  constructor(poolStart, poolEnd) {
    this.poolStart = poolStart;
    this.poolEnd = poolEnd;
    this.lockDir = '/tmp/df-spike-ports';

    if (!fs.existsSync(this.lockDir)) {
      fs.mkdirSync(this.lockDir, { recursive: true });
    }
  }

  allocate() {
    for (let port = this.poolStart; port <= this.poolEnd; port++) {
      const lockFile = path.join(this.lockDir, `${port}.lock`);
      try {
        fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
        return port;
      } catch (e) {
        // Port already locked, try next
        continue;
      }
    }
    throw new Error(`No available ports in pool ${this.poolStart}-${this.poolEnd}`);
  }

  release(port) {
    const lockFile = path.join(this.lockDir, `${port}.lock`);
    try {
      fs.unlinkSync(lockFile);
    } catch (e) {
      // Already released or never locked
    }
  }

  cleanup() {
    const files = fs.readdirSync(this.lockDir);
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;

      const lockFile = path.join(this.lockDir, file);
      const content = fs.readFileSync(lockFile, 'utf8');
      const pid = parseInt(content, 10);

      try {
        process.kill(pid, 0); // Check if process exists
      } catch (e) {
        // Process doesn't exist, clean up stale lock
        fs.unlinkSync(lockFile);
      }
    }
  }
}

class TmpdirManager {
  constructor(prefix = 'spike-') {
    this.prefix = prefix;
  }

  allocate(spikeId) {
    const tmpdir = `/tmp/${this.prefix}${spikeId}`;
    fs.mkdirSync(tmpdir, { recursive: true });
    return tmpdir;
  }

  release(tmpdir) {
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch (e) {
      // Already cleaned or never created
    }
  }
}

// Test scenario: simulate max_parallel concurrent spikes
async function testConcurrentSpikes(maxParallel) {
  const poolManager = new PortPoolManager(9000, 9000 + maxParallel - 1);
  const tmpdirManager = new TmpdirManager();

  poolManager.cleanup();

  const spikes = [];
  const results = [];

  for (let i = 0; i < maxParallel + 1; i++) {
    spikes.push(
      new Promise((resolve, reject) => {
        const spikeId = `test-${i}`;
        let port = null;
        let tmpdir = null;

        try {
          port = poolManager.allocate();
          tmpdir = tmpdirManager.allocate(spikeId);

          results.push({ spikeId, port, tmpdir, status: 'allocated' });

          // Simulate work
          setTimeout(() => {
            poolManager.release(port);
            tmpdirManager.release(tmpdir);
            resolve({ spikeId, port, tmpdir });
          }, 100 + Math.random() * 100);

        } catch (e) {
          results.push({ spikeId, error: e.message, status: 'queued' });

          // Wait for a slot
          const interval = setInterval(() => {
            try {
              port = poolManager.allocate();
              tmpdir = tmpdirManager.allocate(spikeId);
              clearInterval(interval);

              results.push({ spikeId, port, tmpdir, status: 'allocated-after-wait' });

              setTimeout(() => {
                poolManager.release(port);
                tmpdirManager.release(tmpdir);
                resolve({ spikeId, port, tmpdir });
              }, 100);
            } catch (retryE) {
              // Still waiting
            }
          }, 50);
        }
      })
    );
  }

  await Promise.all(spikes);

  return results;
}

// Test SIGTERM cleanup
function testSIGTERMCleanup() {
  const poolManager = new PortPoolManager(9100, 9102);
  const tmpdirManager = new TmpdirManager();

  poolManager.cleanup();

  const port = poolManager.allocate();
  const tmpdir = tmpdirManager.allocate('sigterm-test');

  const cleanup = () => {
    poolManager.release(port);
    tmpdirManager.release(tmpdir);

    // Verify cleanup
    const lockFile = `/tmp/df-spike-ports/${port}.lock`;
    const portLeaked = fs.existsSync(lockFile);
    const tmpdirLeaked = fs.existsSync(tmpdir);

    console.log(JSON.stringify({
      portLeaked,
      tmpdirLeaked,
      port,
      tmpdir
    }));

    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Keep alive
  setTimeout(() => {}, 30000);
}

// Main
const mode = process.argv[2];

if (mode === 'concurrent') {
  const maxParallel = parseInt(process.argv[3] || '3', 10);
  testConcurrentSpikes(maxParallel).then(results => {
    console.log(JSON.stringify(results, null, 2));

    // Verify no leaks
    const allocated = results.filter(r => r.status && r.status.includes('allocated'));
    const uniquePorts = new Set(allocated.map(r => r.port));
    const uniqueTmpdirs = new Set(allocated.map(r => r.tmpdir));

    console.log(`\nUnique ports allocated: ${uniquePorts.size}`);
    console.log(`Unique tmpdirs allocated: ${uniqueTmpdirs.size}`);

    // Check for remaining locks
    const lockDir = '/tmp/df-spike-ports';
    if (fs.existsSync(lockDir)) {
      const remaining = fs.readdirSync(lockDir);
      console.log(`Remaining locks after cleanup: ${remaining.length}`);
    }

    // Check for remaining tmpdirs
    const tmpDirs = fs.readdirSync('/tmp').filter(d => d.startsWith('spike-test-'));
    console.log(`Remaining tmpdirs after cleanup: ${tmpDirs.length}`);
  });
} else if (mode === 'sigterm') {
  testSIGTERMCleanup();
}
