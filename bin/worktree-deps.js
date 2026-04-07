#!/usr/bin/env node
/**
 * deepflow worktree-deps
 * Symlinks node_modules from the main repo into a worktree so that
 * TypeScript / LSP / builds resolve dependencies without a full install.
 *
 * Usage: node bin/worktree-deps.js --source /path/to/repo --worktree /path/to/worktree
 *
 * Walks the source repo looking for node_modules directories (max depth 2)
 * and creates corresponding symlinks in the worktree.
 *
 * Exit codes: 0=OK, 1=ERROR
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) opts.source = args[++i];
    else if (args[i] === '--worktree' && args[i + 1]) opts.worktree = args[++i];
  }
  if (!opts.source || !opts.worktree) {
    console.error('Usage: node bin/worktree-deps.js --source <repo> --worktree <worktree>');
    process.exit(1);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Find node_modules directories (depth 0 and 1 level of nesting)
// ---------------------------------------------------------------------------

function findNodeModules(root) {
  const results = [];

  // Root node_modules
  const rootNM = path.join(root, 'node_modules');
  if (fs.existsSync(rootNM)) {
    results.push('node_modules');
  }

  // Scan common monorepo directory patterns for nested node_modules
  const monorepoPatterns = ['packages', 'apps', 'libs', 'services', 'modules', 'plugins'];

  for (const dir of monorepoPatterns) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;

    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;

      const nm = path.join(entryPath, 'node_modules');
      if (fs.existsSync(nm)) {
        results.push(path.join(dir, entry, 'node_modules'));
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Create symlinks
// ---------------------------------------------------------------------------

function symlinkDeps(source, worktree) {
  const nodeModulesPaths = findNodeModules(source);

  if (nodeModulesPaths.length === 0) {
    console.log('{"linked":0,"message":"no node_modules found in source"}');
    return;
  }

  let linked = 0;
  const errors = [];

  for (const relPath of nodeModulesPaths) {
    const srcAbs = path.join(source, relPath);
    const dstAbs = path.join(worktree, relPath);

    // Skip if already exists (symlink or directory)
    if (fs.existsSync(dstAbs)) {
      continue;
    }

    // Ensure parent directory exists in worktree
    const parent = path.dirname(dstAbs);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    try {
      fs.symlinkSync(srcAbs, dstAbs, 'dir');
      linked++;
    } catch (err) {
      errors.push({ path: relPath, error: err.message });
    }
  }

  const result = { linked, total: nodeModulesPaths.length };
  if (errors.length > 0) result.errors = errors;
  console.log(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs();
symlinkDeps(opts.source, opts.worktree);
