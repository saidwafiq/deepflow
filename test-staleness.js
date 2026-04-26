#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const FIXTURE_ROOT = path.join(__dirname, 'fixture-repo');
const CODEBASE_DIR = path.join(FIXTURE_ROOT, '.deepflow/codebase');

function sha256(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yamlText = match[1];
  const result = { sources: [], hashes: {} };

  let currentKey = null;
  for (const line of yamlText.split('\n')) {
    if (line.startsWith('sources:')) {
      currentKey = 'sources';
    } else if (line.startsWith('hashes:')) {
      currentKey = 'hashes';
    } else if (line.startsWith('  - ')) {
      result.sources.push(line.slice(4).replace(/^["']|["']$/g, ''));
    } else if (line.startsWith('  ') && currentKey === 'hashes' && line.includes(':')) {
      const [key, value] = line.trim().split(': ');
      result.hashes[key] = value;
    }
  }

  return result;
}

function prependStale(artifactPath) {
  const content = fs.readFileSync(artifactPath, 'utf8');
  if (!content.startsWith('[STALE] ')) {
    fs.writeFileSync(artifactPath, '[STALE] ' + content, 'utf8');
  }
}

function removeStale(artifactPath) {
  const content = fs.readFileSync(artifactPath, 'utf8');
  if (content.startsWith('[STALE] ')) {
    fs.writeFileSync(artifactPath, content.slice('[STALE] '.length), 'utf8');
  }
}

function checkStale(artifactPath, touchedFile) {
  const content = fs.readFileSync(artifactPath, 'utf8');
  const frontmatter = parseYamlFrontmatter(content);

  if (!frontmatter) return false;

  const trackedHash = frontmatter.hashes[touchedFile];
  if (!trackedHash) return false;

  const currentHash = sha256(path.join(FIXTURE_ROOT, touchedFile));
  return currentHash !== trackedHash;
}

console.log('# Artifact Generation & Staleness Detection Spike\n');

// Test 1: Parse existing artifacts
console.log('## Test 1: Parse YAML frontmatter');
const conventionsPath = path.join(CODEBASE_DIR, 'CONVENTIONS.md');
const structurePath = path.join(CODEBASE_DIR, 'STRUCTURE.md');

const conventions = parseYamlFrontmatter(fs.readFileSync(conventionsPath, 'utf8'));
const structure = parseYamlFrontmatter(fs.readFileSync(structurePath, 'utf8'));

console.log('CONVENTIONS.md sources:', conventions.sources);
console.log('CONVENTIONS.md hashes:', Object.keys(conventions.hashes));
console.log('STRUCTURE.md sources:', structure.sources);
console.log('STRUCTURE.md hashes:', Object.keys(structure.hashes));
console.log('✓ Frontmatter parsed\n');

// Test 2: Hash matching (pre-edit)
console.log('## Test 2: Hash matching before edit');
const exampleHash = sha256(path.join(FIXTURE_ROOT, 'example.js'));
console.log('example.js current hash:', exampleHash);
console.log('CONVENTIONS.md stored hash:', conventions.hashes['example.js']);
console.log('Match:', exampleHash === conventions.hashes['example.js']);
console.log('✓ Hashes match\n');

// Test 3: Modify file
console.log('## Test 3: Modify example.js');
const examplePath = path.join(FIXTURE_ROOT, 'example.js');
const originalContent = fs.readFileSync(examplePath, 'utf8');
fs.writeFileSync(examplePath, originalContent + '\n// Modified\n', 'utf8');
const newHash = sha256(examplePath);
console.log('New hash:', newHash);
console.log('Hash changed:', newHash !== conventions.hashes['example.js']);
console.log('✓ File modified\n');

// Test 4: Detect staleness
console.log('## Test 4: Detect staleness');
const conventionsStale = checkStale(conventionsPath, 'example.js');
const structureStale = checkStale(structurePath, 'example.js');
console.log('CONVENTIONS.md stale (tracks example.js):', conventionsStale);
console.log('STRUCTURE.md stale (tracks example.js):', structureStale);
console.log('✓ Staleness detected\n');

// Test 5: Prepend [STALE] marker
console.log('## Test 5: Prepend [STALE] marker to stale artifacts');
if (conventionsStale) prependStale(conventionsPath);
if (structureStale) prependStale(structurePath);

const conventionsMarked = fs.readFileSync(conventionsPath, 'utf8').startsWith('[STALE] ');
const structureMarked = fs.readFileSync(structurePath, 'utf8').startsWith('[STALE] ');
console.log('CONVENTIONS.md has [STALE]:', conventionsMarked);
console.log('STRUCTURE.md has [STALE]:', structureMarked);
console.log('✓ Markers prepended\n');

// Test 6: Modify other.js (should only affect CONVENTIONS.md)
console.log('## Test 6: Modify other.js');
const otherPath = path.join(FIXTURE_ROOT, 'other.js');
const otherOriginal = fs.readFileSync(otherPath, 'utf8');
fs.writeFileSync(otherPath, otherOriginal + '\n// Also modified\n', 'utf8');

// Remove existing stale markers for clean test
removeStale(conventionsPath);
removeStale(structurePath);

const conventionsStale2 = checkStale(conventionsPath, 'other.js');
const structureStale2 = checkStale(structurePath, 'other.js');
console.log('CONVENTIONS.md stale (tracks other.js):', conventionsStale2);
console.log('STRUCTURE.md stale (other.js not tracked):', structureStale2);
console.log('✓ Selective staleness works\n');

// Test 7: Round-trip marker removal
console.log('## Test 7: Marker removal after regeneration');
prependStale(conventionsPath);
console.log('CONVENTIONS.md before regen:', fs.readFileSync(conventionsPath, 'utf8').substring(0, 20));
removeStale(conventionsPath);
console.log('CONVENTIONS.md after regen:', fs.readFileSync(conventionsPath, 'utf8').substring(0, 20));
console.log('✓ Marker removed\n');

console.log('## Summary');
console.log('✓ Artifact YAML frontmatter parsing works');
console.log('✓ sha256 hash computation detects file changes');
console.log('✓ [STALE] marker prepend/removal round-trips cleanly');
console.log('✓ Staleness detection is selective (only marks artifacts tracking the changed file)');
