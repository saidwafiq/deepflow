#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Mechanical quality scorer for repo-inspect output.
 * Runs 8 checks against JSON output and ground-truth.json.
 *
 * Usage: node score.js output.json
 * Output: {"score": N, "checks": [...]}
 */

async function score(outputPath) {
  const checks = [];
  let score = 0;

  try {
    // Read output JSON
    let output;
    try {
      const outputContent = fs.readFileSync(outputPath, 'utf8');
      output = JSON.parse(outputContent);
    } catch (e) {
      checks.push({
        name: 'Valid JSON output',
        passed: false,
        reason: `Failed to parse JSON: ${e.message}`
      });
      return { score, checks };
    }

    // If we got here, JSON is valid
    checks.push({
      name: 'Valid JSON output',
      passed: true
    });
    score++;

    // Read ground-truth.json
    const groundTruthPath = path.join(path.dirname(outputPath), 'ground-truth.json');
    const groundTruthContent = fs.readFileSync(groundTruthPath, 'utf8');
    const groundTruth = JSON.parse(groundTruthContent);

    // Check 1: purpose contains "FUSE"/"NFS" + "HuggingFace" (substring)
    const purpose = output.purpose || '';
    const hasFuseOrNfs = /FUSE|NFS/i.test(purpose);
    const hasHuggingFace = /HuggingFace|hugging\s*face/i.test(purpose);
    const check1Pass = hasFuseOrNfs && hasHuggingFace;
    checks.push({
      name: 'purpose contains "FUSE"/"NFS" + "HuggingFace"',
      passed: check1Pass,
      reason: check1Pass ? undefined : `hasFuseOrNfs=${hasFuseOrNfs}, hasHuggingFace=${hasHuggingFace}`
    });
    if (check1Pass) score++;

    // Check 2: language == "Rust" (exact)
    const check2Pass = output.language === groundTruth.language;
    checks.push({
      name: 'language == "Rust"',
      passed: check2Pass,
      reason: check2Pass ? undefined : `got "${output.language}", expected "${groundTruth.language}"`
    });
    if (check2Pass) score++;

    // Check 3: entry_points includes "main.rs" (substring)
    // Support both flat (entry_points) and nested (architecture.entry_points) schemas
    const entryPoints = output.entry_points || (output.architecture && output.architecture.entry_points) || [];
    const check3Pass = entryPoints.some(ep => ep.includes('main.rs'));
    checks.push({
      name: 'entry_points includes "main.rs"',
      passed: check3Pass,
      reason: check3Pass ? undefined : `entry_points: ${JSON.stringify(entryPoints)}`
    });
    if (check3Pass) score++;

    // Check 4: key_modules count >= 3 (threshold)
    // Support both flat (key_modules) and nested (architecture.key_modules) schemas
    const keyModules = output.key_modules || (output.architecture && output.architecture.key_modules) || [];
    const check4Pass = keyModules.length >= 3;
    checks.push({
      name: 'key_modules count >= 3',
      passed: check4Pass,
      reason: check4Pass ? undefined : `count: ${keyModules.length}`
    });
    if (check4Pass) score++;

    // Check 5: dependencies_count within +/-20% of truth (20) (range)
    const depsCount = output.dependencies_count;
    const truthDeps = groundTruth.dependencies_count;
    const tolerance = groundTruth.dependencies_tolerance_pct;
    const minDeps = truthDeps * (1 - tolerance / 100);
    const maxDeps = truthDeps * (1 + tolerance / 100);
    const check5Pass = depsCount !== undefined && depsCount >= minDeps && depsCount <= maxDeps;
    checks.push({
      name: `dependencies_count within +/-${tolerance}% of truth (${truthDeps})`,
      passed: check5Pass,
      reason: check5Pass ? undefined : `got ${depsCount}, range [${minDeps}, ${maxDeps}]`
    });
    if (check5Pass) score++;

    // Check 6: files_inspected count >= 5 (threshold)
    const filesInspected = output.files_inspected || [];
    const filesCount = Array.isArray(filesInspected) ? filesInspected.length : 0;
    const minFiles = groundTruth.min_files_inspected;
    const check6Pass = filesCount >= minFiles;
    checks.push({
      name: `files_inspected count >= ${minFiles}`,
      passed: check6Pass,
      reason: check6Pass ? undefined : `count: ${filesCount}`
    });
    if (check6Pass) score++;

    // Check 7: concepts_for_deepflow count >= 1 (non-empty)
    const concepts = output.concepts_for_deepflow || [];
    const conceptsCount = Array.isArray(concepts) ? concepts.length : 0;
    const minConcepts = groundTruth.min_concepts_count;
    const check7Pass = conceptsCount >= minConcepts;
    checks.push({
      name: `concepts_for_deepflow count >= ${minConcepts}`,
      passed: check7Pass,
      reason: check7Pass ? undefined : `count: ${conceptsCount}`
    });
    if (check7Pass) score++;

    return { score, checks };
  } catch (error) {
    checks.push({
      name: 'Error during scoring',
      passed: false,
      reason: error.message
    });
    return { score, checks };
  }
}

// Main
const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node score.js <output.json>');
  process.exit(1);
}

score(outputPath).then(result => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
});
