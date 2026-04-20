#!/usr/bin/env node
/**
 * prompt-compose.js — resolve agent-prompt templates with {{TOKEN}} placeholders.
 *
 * Usage:
 *   node bin/prompt-compose.js --template <name> --context <file|->
 *
 *   --template <name>   Required. Template file resolved as
 *                       templates/agent-prompts/<name>.md relative to the repo root
 *                       (the parent of the directory containing this script).
 *   --context <path>    Required. Path to a JSON file providing placeholder
 *                       values. Use "-" to read JSON from stdin.
 *   --help, -h          Print placeholder grammar and usage.
 *
 * Placeholder grammar:
 *   - Tokens use the form {{TOKEN}} — uppercase letters and underscores only
 *     (matches /\{\{([A-Z_]+)\}\}/).
 *   - Missing token in context = error (exit 1, stderr message).
 *   - Conditional-empty blocks: the caller PRE-RENDERS optional sections and
 *     passes an empty string when absent. The resolver itself has no branching.
 *
 * Exit codes:
 *   0 — rendered prompt written to stdout.
 *   1 — argument error, I/O error, JSON parse error, or missing token.
 *
 * Design notes (see also experiments/extract-agent-prompt-templates):
 *   - Pure Node stdlib (REQ-3 constraint — no templating dependency).
 *   - Argv parser is hand-rolled (~20 lines) to avoid yargs/minimist.
 *   - Single-pass regex replace keeps the resolver trivially auditable.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HELP_TEXT = [
  'Usage: prompt-compose --template <name> --context <file|->',
  '',
  'Options:',
  '  --template <name>   Template file: templates/agent-prompts/<name>.md',
  '  --context <path>    JSON context file, or "-" to read JSON from stdin',
  '  -h, --help          Show this help text',
  '',
  'Placeholder grammar:',
  '  {{TOKEN}}           uppercase snake case ([A-Z_]+)',
  '  missing = error     (stderr: "prompt-compose: missing token: NAME", exit 1)',
  '  conditional-empty   caller pre-renders optional blocks as empty strings',
  '',
  'Exit codes:',
  '  0  rendered prompt printed to stdout',
  '  1  argument / I/O / JSON / missing-token error',
].join('\n');

/**
 * parseArgv — tiny hand-rolled parser.
 *
 * Supports: --flag value, --flag=value, -h, --help.
 * Returns { template, context, help } or throws Error on malformed input.
 */
function parseArgv(argv) {
  const out = { template: null, context: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    let key = null;
    let val = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        val = argv[++i];
      }
    } else {
      throw new Error('unexpected argument: ' + a);
    }
    if (val === undefined) {
      throw new Error('missing value for --' + key);
    }
    if (key === 'template') {
      out.template = val;
    } else if (key === 'context') {
      out.context = val;
    } else {
      throw new Error('unknown flag: --' + key);
    }
  }
  return out;
}

/**
 * render — single-pass placeholder substitution.
 *
 * Throws on the first missing token so the CLI can surface the exact name
 * and exit 1 (AC-4).
 */
function render(template, ctx) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in ctx)) throw new Error('missing token: ' + k);
    return String(ctx[k]);
  });
}

function readStdinSync() {
  // fd 0 — blocking read of the entire stdin buffer.
  return fs.readFileSync(0, 'utf8');
}

function resolveTemplatePath(name) {
  // Repo root = parent of bin/ directory (where this script lives).
  const repoRoot = path.resolve(__dirname, '..');
  return path.join(repoRoot, 'templates', 'agent-prompts', name + '.md');
}

function main(argv) {
  let args;
  try {
    args = parseArgv(argv);
  } catch (e) {
    process.stderr.write('prompt-compose: ' + e.message + '\n');
    return 1;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT + '\n');
    return 0;
  }

  if (!args.template) {
    process.stderr.write('prompt-compose: --template is required\n');
    return 1;
  }
  if (!args.context) {
    process.stderr.write('prompt-compose: --context is required\n');
    return 1;
  }

  let templateText;
  try {
    templateText = fs.readFileSync(resolveTemplatePath(args.template), 'utf8');
  } catch (e) {
    process.stderr.write('prompt-compose: cannot read template: ' + e.message + '\n');
    return 1;
  }

  let ctxRaw;
  try {
    ctxRaw = args.context === '-'
      ? readStdinSync()
      : fs.readFileSync(args.context, 'utf8');
  } catch (e) {
    process.stderr.write('prompt-compose: cannot read context: ' + e.message + '\n');
    return 1;
  }

  let ctx;
  try {
    ctx = JSON.parse(ctxRaw);
  } catch (e) {
    process.stderr.write('prompt-compose: invalid JSON context: ' + e.message + '\n');
    return 1;
  }
  if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) {
    process.stderr.write('prompt-compose: context must be a JSON object\n');
    return 1;
  }

  let rendered;
  try {
    rendered = render(templateText, ctx);
  } catch (e) {
    process.stderr.write('prompt-compose: ' + e.message + '\n');
    return 1;
  }

  process.stdout.write(rendered);
  return 0;
}

// Export for unit tests; run when invoked directly.
module.exports = { parseArgv, render, resolveTemplatePath, HELP_TEXT, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
