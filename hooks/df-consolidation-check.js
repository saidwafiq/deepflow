#!/usr/bin/env node
/**
 * deepflow consolidation checker
 * Checks if decisions.md needs consolidation, outputs suggestion if overdue
 */

const fs = require('fs');
const path = require('path');

const DAYS_THRESHOLD = 7;
const LINES_THRESHOLD = 20;
const DEEPFLOW_DIR = path.join(process.cwd(), '.deepflow');
const DECISIONS_FILE = path.join(DEEPFLOW_DIR, 'decisions.md');
const LAST_CONSOLIDATED_FILE = path.join(DEEPFLOW_DIR, 'last-consolidated.json');

function checkConsolidation() {
  try {
    // Check if decisions.md exists
    if (!fs.existsSync(DECISIONS_FILE)) {
      process.exit(0);
    }

    // Check if decisions.md has more than LINES_THRESHOLD lines
    const decisionsContent = fs.readFileSync(DECISIONS_FILE, 'utf8');
    const lineCount = decisionsContent.split('\n').length;
    if (lineCount <= LINES_THRESHOLD) {
      process.exit(0);
    }

    // Get last consolidated timestamp
    let lastConsolidated;
    if (fs.existsSync(LAST_CONSOLIDATED_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(LAST_CONSOLIDATED_FILE, 'utf8'));
        if (data.last_consolidated) {
          lastConsolidated = new Date(data.last_consolidated);
        }
      } catch (e) {
        // Fall through to use mtime
      }
    }

    // Fallback: use mtime of decisions.md
    if (!lastConsolidated || isNaN(lastConsolidated.getTime())) {
      const stat = fs.statSync(DECISIONS_FILE);
      lastConsolidated = stat.mtime;
    }

    // Calculate days since last consolidation
    const now = new Date();
    const diffMs = now - lastConsolidated;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays >= DAYS_THRESHOLD) {
      process.stderr.write(
        `\u{1F4A1} decisions.md hasn't been consolidated in ${diffDays} days. Run /df:consolidate to clean up.\n`
      );
    }

  } catch (e) {
    // Fail silently
  }

  process.exit(0);
}

checkConsolidation();
