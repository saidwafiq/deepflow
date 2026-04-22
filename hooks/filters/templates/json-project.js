'use strict';

/**
 * json-project — extracts key fields from package.json / project manifest reads.
 *
 * Archetype: json-project
 * Matches: commands that read or print package.json / composer.json / pyproject.toml
 * (e.g. `cat package.json`, `node -e "...require('./package.json')"`, `npm pkg get`).
 *
 * apply() parses JSON and emits only name, version, scripts keys, and dependency counts.
 */

const MATCH_RE = /\bpackage\.json\b|\bcomposer\.json\b|\bpyproject\.toml\b|npm\s+pkg\s+get/;

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function match(cmd) {
  return MATCH_RE.test(cmd);
}

/**
 * @param {string} raw
 * @returns {{ header: string, body: string, truncated?: { lines: number } }}
 */
function apply(raw) {
  const rawLines = raw.split('\n').length;
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (_) {
    // Not valid JSON — fall back to a safe line-count summary
    const header = '# json-project (parse failed — raw summary)';
    const preview = raw.split('\n').slice(0, 10).join('\n');
    const extra = rawLines > 10 ? rawLines - 10 : 0;
    return extra > 0
      ? { header, body: preview, truncated: { lines: extra } }
      : { header, body: preview };
  }

  const fields = [];
  if (parsed.name)    fields.push(`name:    ${parsed.name}`);
  if (parsed.version) fields.push(`version: ${parsed.version}`);
  if (parsed.type)    fields.push(`type:    ${parsed.type}`);

  // scripts summary
  const scripts = Object.keys(parsed.scripts || {});
  if (scripts.length) {
    fields.push(`scripts (${scripts.length}): ${scripts.slice(0, 8).join(', ')}${scripts.length > 8 ? ', …' : ''}`);
  }

  // dependency counts
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const count = Object.keys(parsed[key] || {}).length;
    if (count) fields.push(`${key}: ${count} packages`);
  }

  const header = `# json-project (${rawLines} lines → ${fields.length} fields)`;
  const body = fields.join('\n');
  const dropped = rawLines - fields.length;

  return dropped > 0
    ? { header, body, truncated: { lines: dropped } }
    : { header, body };
}

module.exports = { name: 'json-project', archetype: 'json-project', match, apply };
