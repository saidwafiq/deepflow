#!/usr/bin/env node
/**
 * build-corpus.js — extract a Meta-Harness corpus from a deepflow-using project.
 *
 * Walks {repo}/specs/done-*.md, pairs each spec with its "feat({slug}): merge
 * verified changes" commit, and produces per-spec task instances under
 * {out}/{slug}/ for use by Mode B (Meta-Harness) evaluation.
 *
 * Outputs per spec:
 *   spec.md             — verbatim copy of done-{slug}.md
 *   baseline.tar.gz     — git archive of repo state at merge_sha^1
 *   ground_truth.patch  — git diff merge_sha^..merge_sha
 *   tests_added.txt     — paths of test files in the diff (one per line)
 *   reward_spec.json    — {spec_id, baseline_sha, merge_sha, domain, tests, reward}
 *
 * Plus a top-level index.yaml listing every spec for human curation
 * (set canonical: true on ~12 specs spanning domains).
 *
 * Usage:
 *   node tools/build-corpus.js [--repo PATH] [--out PATH] [--dry-run] [--limit N]
 *
 * Defaults: --repo ~/apps/bingo-rgs, --out ~/meta-harness/corpus
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, execSync } = require('node:child_process');

const DEFAULT_REPO = path.join(os.homedir(), 'apps', 'bingo-rgs');
const DEFAULT_OUT = path.join(os.homedir(), 'meta-harness', 'corpus');

const TEST_RE = /(_test\.go$|\.test\.(ts|tsx|jsx|js|mjs)$|_test\.py$|^tests\/|\/__tests__\/|^test\/)/;

function parseArgs() {
  const args = { repo: DEFAULT_REPO, out: DEFAULT_OUT, dryRun: false, limit: Infinity };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/build-corpus.js [--repo PATH] [--out PATH] [--dry-run] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

function git(repo, ...gitArgs) {
  return execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' }).trim();
}

function findMergeCommit(repo, slug) {
  // Bingo-rgs conventions (in priority order):
  //   feat({slug}): merge verified changes  — primary pattern
  //   fix/refactor/chore({slug}): merge verified  — variants
  //   merge({slug}): ...  — early specs (03a, 03b)
  // Uses basic POSIX regex (default) — parens are literal, no escaping needed.
  const patterns = [
    `feat(${slug}): merge verified`,
    `fix(${slug}): merge verified`,
    `refactor(${slug}): merge verified`,
    `chore(${slug}): merge verified`,
    `merge(${slug}):`,
    `Merge branch 'df/doing-${slug}'`,
    `Merge branch 'df/${slug}'`,
    `Merge branch '${slug}'`,
  ];
  for (const pat of patterns) {
    try {
      const result = execFileSync('git', [
        '-C', repo,
        'log', '--merges', '--format=%H',
        `--grep=${pat}`,
        '--fixed-strings',
      ], { encoding: 'utf8' }).trim();
      if (result) return result.split('\n')[0]; // most recent
    } catch (_) {
      // continue
    }
  }
  return null;
}

function classifyDomain(diffFiles) {
  const counts = { go: 0, ts: 0, sql: 0, proto: 0, infra: 0, dbt: 0, py: 0, doc: 0 };
  for (const f of diffFiles) {
    if (/^dbt\//.test(f)) counts.dbt++;
    else if (/(^|\/)Dockerfile|compose.*\.ya?ml$|^infra\/|^deploy\//.test(f)) counts.infra++;
    else if (/\.proto$/.test(f)) counts.proto++;
    else if (/\.sql$/.test(f)) counts.sql++;
    else if (/\.go$/.test(f)) counts.go++;
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(f)) counts.ts++;
    else if (/\.py$/.test(f)) counts.py++;
    else if (/\.(md|txt|adoc)$/.test(f)) counts.doc++;
  }

  // Significant domains: any with at least 10% share of non-doc files.
  const total = Object.values(counts).reduce((a, b) => a + b, 0) - counts.doc;
  if (total === 0) return 'doc-only';

  const sig = [];
  for (const [k, v] of Object.entries(counts)) {
    if (k === 'doc') continue;
    if (v / total >= 0.1) sig.push(k);
  }
  if (sig.length === 0) return 'mixed';
  if (sig.length === 1) return sig[0];
  return sig.sort().join('+');
}

function buildRewardSpec(tests, domain, repo) {
  const reward = { build: null, lint: null, test: null, ac_check: 'df-ac-coverage' };

  // Detect what to run based on tests + domain
  const hasGoTests = tests.some(t => t.endsWith('_test.go'));
  const hasTsTests = tests.some(t => /\.test\.(ts|tsx|js|jsx|mjs)$/.test(t));
  const hasPyTests = tests.some(t => t.endsWith('_test.py'));

  if (domain.includes('go') || hasGoTests) {
    reward.build = 'go build ./...';
    reward.lint = 'go vet ./...';
    if (hasGoTests) {
      // Scope tests to packages that have test files added/modified
      const goPkgs = new Set(tests.filter(t => t.endsWith('_test.go')).map(t => './' + path.dirname(t) + '/...'));
      reward.test_go = Array.from(goPkgs).join(' ');
    }
  }
  if (domain.includes('ts') || hasTsTests) {
    // bingo-rgs uses pnpm workspaces; build via root
    if (fs.existsSync(path.join(repo, 'pnpm-workspace.yaml'))) {
      reward.build_ts = 'pnpm -r build';
      reward.test_ts = 'pnpm -r test';
    } else if (fs.existsSync(path.join(repo, 'package.json'))) {
      reward.build_ts = 'npm run build';
      reward.test_ts = 'npm test';
    }
  }
  if (hasPyTests) {
    reward.test_py = 'python -m pytest';
  }
  return reward;
}

function processSpec(specPath, repo, outDir, dryRun) {
  const slug = path.basename(specPath, '.md').replace(/^done-/, '');
  const mergeSha = findMergeCommit(repo, slug);

  if (!mergeSha) return { slug, status: 'no_match' };

  const baselineSha = git(repo, 'rev-parse', `${mergeSha}^1`);
  const diffFiles = git(repo, 'diff', '--name-only', `${mergeSha}^..${mergeSha}`)
    .split('\n').filter(Boolean);
  const tests = diffFiles.filter(f => TEST_RE.test(f));
  const domain = classifyDomain(diffFiles);
  const reward = buildRewardSpec(tests, domain, repo);
  const diffStat = git(repo, 'diff', '--shortstat', `${mergeSha}^..${mergeSha}`);

  const summary = {
    slug,
    status: 'matched',
    mergeSha: mergeSha.slice(0, 8),
    baselineSha: baselineSha.slice(0, 8),
    tests: tests.length,
    files: diffFiles.length,
    domain,
    diffStat,
  };

  if (dryRun) return summary;

  const specDir = path.join(outDir, slug);
  fs.mkdirSync(specDir, { recursive: true });

  fs.copyFileSync(specPath, path.join(specDir, 'spec.md'));

  execSync(
    `git -C "${repo}" archive --format=tar ${baselineSha} | gzip > "${path.join(specDir, 'baseline.tar.gz')}"`,
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  execSync(
    `git -C "${repo}" diff ${mergeSha}^..${mergeSha} > "${path.join(specDir, 'ground_truth.patch')}"`,
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  fs.writeFileSync(path.join(specDir, 'tests_added.txt'), tests.join('\n') + (tests.length > 0 ? '\n' : ''));

  fs.writeFileSync(
    path.join(specDir, 'reward_spec.json'),
    JSON.stringify({
      spec_id: slug,
      baseline_sha: baselineSha,
      merge_sha: mergeSha,
      domain,
      tests_added: tests,
      reward,
      diff_stat: diffStat,
    }, null, 2) + '\n'
  );

  return summary;
}

function generateIndexYaml(results, repo) {
  const matched = results.filter(r => r.status === 'matched');
  const unmatched = results.filter(r => r.status !== 'matched').map(r => r.slug);

  const lines = [
    '# Corpus index — auto-generated by tools/build-corpus.js',
    `generated_at: ${new Date().toISOString()}`,
    `source_repo: ${repo}`,
    `total_specs: ${results.length}`,
    `matched: ${matched.length}`,
    `unmatched_count: ${unmatched.length}`,
  ];
  if (unmatched.length > 0) {
    lines.push('unmatched:');
    for (const s of unmatched) lines.push(`  - ${s}`);
  }
  lines.push('');
  lines.push('# Mark canonical: true on ~12 specs for Mode B initial search set.');
  lines.push('# Aim for cross-domain coverage: go, ts, dbt, proto, infra, sql.');
  lines.push('specs:');
  for (const r of matched) {
    lines.push(`  - id: ${r.slug}`);
    lines.push(`    domain: ${r.domain}`);
    lines.push(`    merge_sha: ${r.mergeSha}`);
    lines.push(`    baseline_sha: ${r.baselineSha}`);
    lines.push(`    files: ${r.files}`);
    lines.push(`    tests_count: ${r.tests}`);
    lines.push(`    diff_stat: "${r.diffStat}"`);
    lines.push(`    canonical: false`);
  }
  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs();
  const specsDir = path.join(args.repo, 'specs');

  if (!fs.existsSync(specsDir)) {
    console.error(`✗ No specs/ directory in ${args.repo}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(args.repo, '.git'))) {
    console.error(`✗ Not a git repo: ${args.repo}`);
    process.exit(1);
  }

  if (!args.dryRun) fs.mkdirSync(args.out, { recursive: true });

  const specs = fs.readdirSync(specsDir)
    .filter(f => f.startsWith('done-') && f.endsWith('.md'))
    .sort()
    .slice(0, args.limit)
    .map(f => path.join(specsDir, f));

  console.log(`Found ${specs.length} done specs in ${specsDir}\n`);

  const results = [];
  for (const spec of specs) {
    const r = processSpec(spec, args.repo, args.out, args.dryRun);
    results.push(r);
    if (r.status === 'matched') {
      console.log(`  ✓ ${r.slug.padEnd(40)} ${r.domain.padEnd(12)} ${r.tests} tests  ${r.diffStat}`);
    } else {
      console.log(`  ✗ ${r.slug.padEnd(40)} no merge commit`);
    }
  }

  if (!args.dryRun) {
    const yaml = generateIndexYaml(results, args.repo);
    fs.writeFileSync(path.join(args.out, 'index.yaml'), yaml);
  }

  const matched = results.filter(r => r.status === 'matched').length;
  console.log(`\n${args.dryRun ? '[dry-run] ' : ''}${matched}/${results.length} corpus entries${args.dryRun ? ' would be' : ''} written to ${args.out}`);
  if (!args.dryRun) {
    console.log(`Edit ${path.join(args.out, 'index.yaml')} — mark canonical: true on ~12 specs.`);
    console.log(`Then run \`node tools/harvest-pr-journey.js\` to add commit-journey data per spec (commits, types, wall time, reverts, optional GitHub PR augmentation).`);
  }
}

if (require.main === module) main();

module.exports = { findMergeCommit, classifyDomain, buildRewardSpec, TEST_RE };
