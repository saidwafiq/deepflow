#!/usr/bin/env node
/**
 * harvest-pr-journey.js — extract the journey-to-merge for each corpus spec.
 *
 * Per-spec output: corpus/{slug}/pr_journey.json
 *
 * Primary source is **git history** (always available, fast). For each spec,
 * we walk the merged branch (or the single FF commit range), classify each
 * commit by conventional-commit type, and compute wall-time + counts. This
 * captures the iteration signal Mode B wants regardless of whether the spec
 * went through a GitHub PR.
 *
 * When `gh` CLI is available and the merge_sha has an associated PR (rare in
 * bingo-rgs — most merges are local), augment with PR data: CI failures,
 * review/comment counts, force-push event count.
 *
 * Usage:
 *   node tools/harvest-pr-journey.js \
 *     [--repo PATH]      # default: ~/apps/bingo-rgs (auto-detected if it's a corpus source)
 *     [--corpus PATH]    # default: ~/meta-harness/corpus
 *     [--slug SLUG]      # single spec
 *     [--no-github]      # skip gh API calls
 *     [--dry-run]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const DEFAULT_REPO = path.join(os.homedir(), 'apps', 'bingo-rgs');
const DEFAULT_CORPUS = path.join(os.homedir(), 'meta-harness', 'corpus');

const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/;

function parseArgs() {
  const args = {
    repo: DEFAULT_REPO,
    corpus: DEFAULT_CORPUS,
    slug: null,
    withGithub: true,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--slug') args.slug = argv[++i];
    else if (a === '--no-github') args.withGithub = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/harvest-pr-journey.js [--repo PATH] [--corpus PATH] [--slug SLUG] [--no-github] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

function git(repo, ...gitArgs) {
  return execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' }).trim();
}

function gitSafe(repo, ...gitArgs) {
  try {
    return git(repo, ...gitArgs);
  } catch (_) {
    return null;
  }
}

function isMergeCommit(repo, sha) {
  // A merge commit has 2+ parents. `git rev-parse <sha>^2` succeeds iff parent 2 exists.
  return gitSafe(repo, 'rev-parse', '--verify', `${sha}^2`) !== null;
}

function classifyCommit(subject) {
  const m = subject.match(CONVENTIONAL_RE);
  if (!m) return { type: 'other', scope: null };
  return { type: m[1].toLowerCase(), scope: m[2] || null };
}

function walkCommits(repo, mergeSha) {
  // Determine the commit range that represents the work merged in.
  // - Real merge commit: parent1..parent2 (feature branch commits)
  // - Fast-forward / squash: just the merge_sha itself
  const isMerge = isMergeCommit(repo, mergeSha);

  let range;
  if (isMerge) {
    range = `${mergeSha}^1..${mergeSha}^2`;
  } else {
    // Walk back to find a sensible start. Use single-commit range.
    range = `${mergeSha}^..${mergeSha}`;
  }

  const log = gitSafe(repo, 'log', range, '--format=%H%x09%aI%x09%s', '--reverse');
  if (!log) return { is_merge: isMerge, commits: [] };

  const commits = log.split('\n').filter(Boolean).map((line) => {
    const [sha, date, ...subjParts] = line.split('\t');
    const subject = subjParts.join('\t');
    const cls = classifyCommit(subject);
    return { sha, date, subject, type: cls.type, scope: cls.scope };
  });

  return { is_merge: isMerge, commits };
}

function summarizeCommits(commits) {
  const byType = {};
  for (const c of commits) {
    byType[c.type] = (byType[c.type] || 0) + 1;
  }
  return byType;
}

function lookupGithubPR(repo, mergeSha, timeoutMs = 10000) {
  // Try to detect "Merge pull request #N" pattern in commit message first.
  const subject = gitSafe(repo, 'log', '-1', '--format=%s', mergeSha);
  const prMatch = subject && subject.match(/Merge pull request #(\d+)/);

  // Fall back to GitHub API by commit SHA.
  let prData = null;
  try {
    const apiPath = prMatch
      ? `repos/{owner}/{repo}/pulls/${prMatch[1]}`
      : `repos/{owner}/{repo}/commits/${mergeSha}/pulls`;
    const raw = execFileSync('gh', ['api', apiPath], {
      cwd: repo,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    prData = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!prData || !prData.number) prData = null;
  } catch (_) {
    return null;
  }

  if (!prData) return null;

  // Augment with events (force-push detection) and check runs.
  let forcePushCount = 0;
  let failedCheckRuns = [];
  try {
    const events = JSON.parse(execFileSync('gh', [
      'api', `repos/{owner}/{repo}/issues/${prData.number}/events`,
    ], { cwd: repo, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }));
    forcePushCount = events.filter((e) => e.event === 'head_ref_force_pushed').length;
  } catch (_) {
    /* skip */
  }
  try {
    const checks = JSON.parse(execFileSync('gh', [
      'api', `repos/{owner}/{repo}/commits/${prData.head?.sha || mergeSha}/check-runs`,
    ], { cwd: repo, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }));
    failedCheckRuns = (checks.check_runs || [])
      .filter((c) => c.conclusion === 'failure' || c.conclusion === 'cancelled')
      .map((c) => ({ name: c.name, conclusion: c.conclusion }));
  } catch (_) {
    /* skip */
  }

  return {
    number: prData.number,
    state: prData.state,
    title: prData.title,
    created_at: prData.created_at,
    merged_at: prData.merged_at,
    closed_at: prData.closed_at,
    commits_count: prData.commits,
    comment_count: prData.comments,
    review_comment_count: prData.review_comments,
    additions: prData.additions,
    deletions: prData.deletions,
    changed_files: prData.changed_files,
    force_push_count: forcePushCount,
    failed_check_runs: failedCheckRuns,
  };
}

function harvestSpec(slug, args) {
  const corpusDir = path.join(args.corpus, slug);
  const rewardSpecPath = path.join(corpusDir, 'reward_spec.json');
  if (!fs.existsSync(rewardSpecPath)) {
    return { slug, status: 'no_corpus_entry' };
  }

  const reward = JSON.parse(fs.readFileSync(rewardSpecPath, 'utf8'));
  const mergeSha = reward.merge_sha;
  if (!mergeSha) return { slug, status: 'no_merge_sha' };

  const walk = walkCommits(args.repo, mergeSha);
  const counts = summarizeCommits(walk.commits);

  let firstAt = null;
  let lastAt = null;
  if (walk.commits.length > 0) {
    firstAt = walk.commits[0].date;
    lastAt = walk.commits[walk.commits.length - 1].date;
  } else {
    // Fall back to merge commit timestamp
    lastAt = gitSafe(args.repo, 'log', '-1', '--format=%aI', mergeSha);
    firstAt = lastAt;
  }
  const wallSeconds = firstAt && lastAt
    ? Math.max(0, Math.round((new Date(lastAt) - new Date(firstAt)) / 1000))
    : 0;

  const journey = {
    spec_id: slug,
    merge_sha: mergeSha,
    merge_type: walk.is_merge ? 'merge_commit' : 'fast_forward_or_squash',
    first_commit_at: firstAt,
    merged_at: lastAt,
    wall_seconds: wallSeconds,
    commits_count: walk.commits.length,
    commits_by_type: counts,
    revert_count: walk.commits.filter((c) => c.type === 'revert' || /^Revert /i.test(c.subject)).length,
    commits: walk.commits,
    github_pr: null,
  };

  if (args.withGithub) {
    journey.github_pr = lookupGithubPR(args.repo, mergeSha);
  }

  if (!args.dryRun) {
    fs.writeFileSync(
      path.join(corpusDir, 'pr_journey.json'),
      JSON.stringify(journey, null, 2) + '\n'
    );
  }

  return {
    slug,
    status: 'ok',
    commits_count: journey.commits_count,
    wall_hours: (wallSeconds / 3600).toFixed(1),
    has_pr: journey.github_pr !== null,
    revert_count: journey.revert_count,
  };
}

function main() {
  const args = parseArgs();

  if (!fs.existsSync(args.corpus)) {
    console.error(`✗ Corpus not found: ${args.corpus}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(args.repo, '.git'))) {
    console.error(`✗ Not a git repo: ${args.repo}`);
    process.exit(1);
  }

  let slugs;
  if (args.slug) {
    slugs = [args.slug];
  } else {
    slugs = fs.readdirSync(args.corpus)
      .filter((f) => {
        const p = path.join(args.corpus, f);
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'reward_spec.json'));
      })
      .sort();
  }

  console.log(`Repo:       ${args.repo}`);
  console.log(`Corpus:     ${args.corpus}`);
  console.log(`Specs:      ${slugs.length}`);
  console.log(`GitHub:     ${args.withGithub ? 'enabled (fail-soft)' : 'skipped'}`);
  console.log('');

  const results = [];
  for (const slug of slugs) {
    const r = harvestSpec(slug, args);
    results.push(r);
    if (r.status === 'ok') {
      const prMark = r.has_pr ? ' [PR]' : '';
      const revertMark = r.revert_count > 0 ? ` ⟲${r.revert_count}` : '';
      console.log(`  ✓ ${slug.padEnd(40)} ${String(r.commits_count).padStart(3)} commits  ${r.wall_hours.padStart(6)}h${prMark}${revertMark}`);
    } else {
      console.log(`  ✗ ${slug.padEnd(40)} ${r.status}`);
    }
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const withPr = results.filter((r) => r.has_pr).length;
  console.log(`\n${args.dryRun ? '[dry-run] ' : ''}${ok}/${slugs.length} journeys${args.dryRun ? ' would be' : ''} written. ${withPr} have GitHub PR augmentation.`);
}

if (require.main === module) main();

module.exports = { walkCommits, summarizeCommits, classifyCommit, lookupGithubPR };
