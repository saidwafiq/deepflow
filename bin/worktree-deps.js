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
  const seen = new Set();

  function addIfNM(relDir) {
    if (seen.has(relDir)) return;
    const abs = path.join(root, relDir, 'node_modules');
    if (fs.existsSync(abs)) {
      seen.add(relDir);
      results.push(relDir === '.' ? 'node_modules' : path.join(relDir, 'node_modules'));
    }
  }

  // Root node_modules
  addIfNM('.');

  // Walk every top-level directory up to 2 levels deep looking for node_modules.
  // This covers both flat layouts (go/frontend, web/admin) and monorepo layouts
  // (packages/foo, apps/bar) without hardcoding directory names.
  function walk(relDir, depth) {
    if (depth > 2) return;
    const abs = path.join(root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const childRel = relDir === '.' ? entry.name : path.join(relDir, entry.name);
      addIfNM(childRel);
      walk(childRel, depth + 1);
    }
  }

  walk('.', 1);

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
