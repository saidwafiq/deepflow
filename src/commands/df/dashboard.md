---
name: df:dashboard
description: View deepflow dashboard in team mode (via URL) or local mode (via CLI server)
allowed-tools: [Read, Bash]
---

# /df:dashboard — Deepflow Dashboard

View the deepflow dashboard in team or local mode.

**NEVER:** Spawn agents, use Task tool, use AskUserQuestion, run git, EnterPlanMode, ExitPlanMode

**ONLY:** Read config, run npx deepflow-dashboard, open browser

## Behavior

1. **Check config mode**
   - Read `.deepflow/config.yaml`
   - If `dashboard_url` key exists and is non-empty: TEAM MODE
   - Else: LOCAL MODE

2. **TEAM MODE** (dashboard_url configured)
   - Display: `Dashboard URL configured: {dashboard_url}`
   - Open URL in browser via `open "{dashboard_url}"` (macOS) or appropriate command for OS

3. **LOCAL MODE** (no dashboard_url)
   - Display: `Starting local deepflow dashboard server...`
   - Run: `npx deepflow-dashboard`
   - Instruct user to open http://localhost:3000 (or configured port) in browser

## Rules

- Gracefully handle missing config.yaml (treat as LOCAL MODE)
- If dashboard_url exists but is empty string, treat as LOCAL MODE
- Always confirm mode and action before executing
