#!/usr/bin/env node
/**
 * Fixture invariant hook
 *
 * Mirrors the structure of the real deepflow invariant hook.
 * Checks that no files outside allowed paths were modified.
 *
 * Exit 0 = pass, exit 1 = block with message.
 */

const input = JSON.parse(process.argv[2] || '{}');
const toolName = input.tool_name || '';
const toolInput = input.tool_input || {};

// Paths that are read-only in the fixture
const PROTECTED = ['specs/', '.deepflow/config.yaml', 'hooks/', 'package.json'];

if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
  const filePath = toolInput.file_path || toolInput.path || '';
  const violation = PROTECTED.find((p) => filePath.startsWith(p));

  if (violation) {
    console.error(`[invariant] Blocked write to protected path: ${filePath}`);
    process.exit(1);
  }
}

process.exit(0);
