#!/usr/bin/env node
/**
 * Scans specs/*.md for derives-from frontmatter and writes .deepflow/lineage.jsonl
 *
 * Each line: { "child": "fix-auth", "parent": "done-auth", "child_status": "doing", "scanned_at": "ISO" }
 *
 * Usage: node bin/lineage-ingest.js [--specs-dir specs/] [--out .deepflow/lineage.jsonl]
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../hooks/df-spec-lint.js');

function main() {
  const args = process.argv.slice(2);
  const specsDir = getArg(args, '--specs-dir') || 'specs';
  const outFile = getArg(args, '--out') || path.join('.deepflow', 'lineage.jsonl');

  if (!fs.existsSync(specsDir)) {
    process.stderr.write(`lineage-ingest: specs dir not found: ${specsDir}\n`);
    process.exit(1);
  }

  const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md'));
  const entries = [];
  const now = new Date().toISOString();

  for (const file of files) {
    const content = fs.readFileSync(path.join(specsDir, file), 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    const derivesFrom = frontmatter['derives-from'];

    if (!derivesFrom) continue;

    const specName = file.replace(/\.md$/, '');
    let childStatus = 'planned';
    if (specName.startsWith('doing-')) childStatus = 'doing';
    else if (specName.startsWith('done-')) childStatus = 'done';

    entries.push({
      child: specName,
      parent: derivesFrom,
      child_status: childStatus,
      scanned_at: now
    });
  }

  // Ensure output dir exists
  const outDir = path.dirname(outFile);
  if (outDir && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Overwrite — full scan each time, no append
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outFile, lines ? lines + '\n' : '');

  process.stdout.write(`lineage-ingest: ${entries.length} lineage entries written to ${outFile}\n`);
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

module.exports = { main };

if (require.main === module) {
  main();
}
