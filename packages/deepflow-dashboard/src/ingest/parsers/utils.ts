/**
 * Decode Claude Code project dir name to a human-readable project name.
 * e.g. "-Users-saidsalles-apps-bingo-go" → "bingo-go"
 * Worktree dirs like "...--deepflow-worktrees-spike" → "deepflow (spike)"
 */
export function projectNameFromDir(dirName: string): string {
  // Split on worktree separator
  const [mainPath, worktreePart] = dirName.split('--', 2);
  // Take last meaningful segment from the path
  const segments = mainPath.replace(/^-+/, '').split('-').filter(Boolean);
  // Walk from end to find the project name (skip user/apps prefix)
  // Pattern: Users-user-apps-projectName or Users-user-apps-org-projectName
  const appsIdx = segments.lastIndexOf('apps');
  const name = appsIdx >= 0 && appsIdx < segments.length - 1
    ? segments.slice(appsIdx + 1).join('-')
    : segments.slice(-1)[0] ?? dirName;

  if (worktreePart) {
    const wtSegments = worktreePart.split('-').filter(Boolean);
    // Remove "deepflow-worktrees" or "claude-worktrees" prefix
    const wtIdx = wtSegments.findIndex(s => s === 'worktrees');
    const suffix = wtIdx >= 0 ? wtSegments.slice(wtIdx + 1).join('-') : wtSegments.join('-');
    return suffix ? `${name} (${suffix})` : name;
  }

  return name;
}
