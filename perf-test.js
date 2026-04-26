#!/usr/bin/env node
/**
 * Synthetic parser performance test
 * Validates that line-scan + regex strategy can parse 200 decisions + 50 experiments < 500ms
 */

const fs = require('fs');
const path = require('path');

// Generate synthetic decisions.md with 200 entries
function generateDecisions() {
  const tags = ['APPROACH', 'PROVISIONAL', 'ASSUMPTION', 'FUTURE', 'UPDATE'];
  const filePaths = [
    'src/commands/df/plan.md',
    'src/skills/df-decisions/SKILL.md',
    'bin/install.js',
    'templates/spec-template.md',
    'hooks/invariant.js'
  ];

  let content = '# Architectural Decisions\n\n';
  content += '## 2026-04-25 — synthetic-test\n\n';

  for (let i = 0; i < 200; i++) {
    const tag = tags[i % tags.length];
    const paths = [
      filePaths[i % filePaths.length],
      filePaths[(i + 1) % filePaths.length]
    ];
    content += `- [${tag}] Decision ${i} — rationale ${i} Files: [${paths.join(', ')}]\n`;
  }

  return content;
}

// Generate synthetic experiment files (50 files)
function generateExperiments(tmpDir) {
  const statuses = ['passed', 'failed', 'inconclusive'];
  const filePaths = [
    'src/commands/df/plan.md',
    'src/skills/df-decisions/SKILL.md',
    'bin/install.js',
    'templates/spec-template.md'
  ];

  const files = [];
  for (let i = 0; i < 50; i++) {
    const status = statuses[i % statuses.length];
    const filename = `test-${i}--hypothesis-${i}--${status}.md`;
    const filepath = path.join(tmpDir, filename);
    const paths = [
      filePaths[i % filePaths.length],
      filePaths[(i + 2) % filePaths.length]
    ];

    const content = `---
files: [${paths.join(', ')}]
---

## Hypothesis

Test hypothesis ${i}

## Results

Test results ${i}

## Conclusion

${status.toUpperCase()}
`;

    fs.writeFileSync(filepath, content, 'utf8');
    files.push(filename);
  }

  return files;
}

// Parser implementation (matching spec strategy)
function parseDecisions(content) {
  const decisions = [];
  const lines = content.split('\n');
  const filesRegex = /Files:\s*\[([^\]]+)\]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^\s*[-*]\s+\[/)) {
      const match = line.match(filesRegex);
      if (match) {
        const paths = match[1].split(',').map(p => p.trim());
        decisions.push({ line: i + 1, text: line.trim(), files: paths });
      }
    }
  }

  return decisions;
}

function parseExperiment(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  const basename = path.basename(filepath);

  // Extract status from filename
  const statusMatch = basename.match(/--([^.]+)\.md$/);
  const status = statusMatch ? statusMatch[1] : 'unknown';

  // Try YAML frontmatter first
  if (content.startsWith('---')) {
    const frontmatterEnd = content.indexOf('---', 3);
    if (frontmatterEnd > 0) {
      const frontmatter = content.slice(3, frontmatterEnd);
      const filesMatch = frontmatter.match(/files:\s*\[([^\]]+)\]/);
      if (filesMatch) {
        const paths = filesMatch[1].split(',').map(p => p.trim());
        return { path: basename, status, files: paths };
      }
    }
  }

  // Fallback: scan first 20 lines for inline Files: tag
  const lines = content.split('\n').slice(0, 20);
  const filesRegex = /Files:\s*\[([^\]]+)\]/;
  for (const line of lines) {
    const match = line.match(filesRegex);
    if (match) {
      const paths = match[1].split(',').map(p => p.trim());
      return { path: basename, status, files: paths };
    }
  }

  return null;
}

function queryIndex(decisionsPath, experimentsDir, targetPaths) {
  const targetSet = new Set(targetPaths);

  // Parse decisions
  const decisionsContent = fs.readFileSync(decisionsPath, 'utf8');
  const allDecisions = parseDecisions(decisionsContent);
  const matchedDecisions = allDecisions.filter(d =>
    d.files.some(f => targetSet.has(f))
  );

  // Parse experiments
  const experimentFiles = fs.readdirSync(experimentsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(experimentsDir, f));

  const matchedExperiments = [];
  for (const expPath of experimentFiles) {
    const exp = parseExperiment(expPath);
    if (exp && exp.files.some(f => targetSet.has(f))) {
      matchedExperiments.push(exp);
    }
  }

  return {
    decisions: matchedDecisions.map(d => ({ line: d.line, text: d.text })),
    experiments: matchedExperiments
  };
}

// Run benchmark
function runBenchmark() {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'decisions-bench-'));

  try {
    // Generate fixtures
    const decisionsPath = path.join(tmpDir, 'decisions.md');
    const experimentsDir = path.join(tmpDir, 'experiments');
    fs.mkdirSync(experimentsDir);

    fs.writeFileSync(decisionsPath, generateDecisions(), 'utf8');
    generateExperiments(experimentsDir);

    // Benchmark query
    const targetPaths = ['src/commands/df/plan.md', 'bin/install.js'];

    const start = process.hrtime.bigint();
    const result = queryIndex(decisionsPath, experimentsDir, targetPaths);
    const end = process.hrtime.bigint();

    const durationMs = Number(end - start) / 1_000_000;

    console.log(JSON.stringify({
      durationMs: Math.round(durationMs * 100) / 100,
      decisionsMatched: result.decisions.length,
      experimentsMatched: result.experiments.length,
      threshold: 500,
      pass: durationMs < 500
    }, null, 2));

    return durationMs < 500 ? 0 : 1;
  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

process.exit(runBenchmark());
