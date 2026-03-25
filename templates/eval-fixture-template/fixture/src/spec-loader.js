/**
 * Spec loader
 *
 * Finds the active spec in the specs/ directory.
 * Active spec = first file matching `doing-*.md`.
 */

const fs = require('fs');
const path = require('path');

function loadSpec(specsDir = 'specs') {
  if (!fs.existsSync(specsDir)) return null;

  const files = fs.readdirSync(specsDir);
  const active = files.find((f) => f.startsWith('doing-') && f.endsWith('.md'));

  if (!active) return null;

  const content = fs.readFileSync(path.join(specsDir, active), 'utf8');
  return parseSpec(active.replace(/^doing-/, '').replace(/\.md$/, ''), content);
}

function parseSpec(name, content) {
  const tasks = [];
  const taskPattern = /^##\s+T(\d+):\s+(.+)$/gm;
  let match;

  while ((match = taskPattern.exec(content)) !== null) {
    tasks.push({ id: `T${match[1]}`, description: match[2].trim() });
  }

  return { name, content, tasks };
}

module.exports = { loadSpec, parseSpec };
