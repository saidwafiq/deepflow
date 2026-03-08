```
     _                      __ _
  __| | ___  ___ _ __      / _| | _____      __
 / _` |/ _ \/ _ \ '_ \    | |_| |/ _ \ \ /\ / /
| (_| |  __/  __/ |_) |   |  _| | (_) \ V  V /
 \__,_|\___|\___| .__/    |_| |_|\___/ \_/\_/
               |_|
```

<p align="center">
  <strong>Stay in flow state — spec-driven task orchestration for Claude Code</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#two-modes">Two Modes</a> •
  <a href="#commands">Commands</a>
</p>

---

## Philosophy

- **Specs define intent**, tasks close reality gaps
- **You decide WHAT to build** — the AI decides HOW
- **Two modes:** interactive (human-in-the-loop) and autonomous (overnight, unattended)
- **Spike-first planning** — Validate risky hypotheses before full implementation
- **Worktree isolation** — Main branch stays clean during execution
- **Atomic commits** for clean rollback

## Quick Start

```bash
# Install (or update)
npx deepflow

# Uninstall
npx deepflow --uninstall
```

## Two Modes

deepflow has two modes of operation. Both start from the same artifact: a **spec**.

### Interactive Mode (human-in-the-loop)

You drive each step inside a Claude Code session. Good for when you want control over the process, are exploring a new domain, or want to iterate on the spec.

```bash
claude

# 1. Explore the problem space (conversation with you)
/df:discover image-upload

# 2. Debate tradeoffs (optional, 4 AI perspectives)
/df:debate upload-strategy

# 3. Generate spec from conversation
/df:spec image-upload

# 4. Generate task plan from spec
/df:plan

# 5. Execute tasks (parallel agents, you watch)
/df:execute

# 6. Verify and merge to main
/df:verify
```

**What requires you:** Steps 1-3 (defining the problem and approving the spec). Steps 4-6 run autonomously but you trigger each one and can intervene.

### Autonomous Mode (unattended)

You write the specs, then walk away. The AI runs the full pipeline — hypothesis generation, parallel spikes, implementation, adversarial self-selection, verification — without any human intervention.

```bash
# You define WHAT (the specs), the AI figures out HOW, overnight

# Inside Claude Code (requires Agent Teams)
/df:auto                         # process all specs in specs/
```

**What the AI does alone:**
1. Pre-checks if spec is already satisfied (skips if so)
2. Discovers specs, respects `depends_on` ordering
3. Generates N hypotheses for how to implement each spec
4. Runs parallel spikes in isolated worktrees (one per hypothesis)
5. Implements the passing approaches
6. Adversarial selection: a fresh AI context compares approaches by artifacts only (never reads code), picks the best or rejects all
7. If rejected: generates new hypotheses, retries (up to max-cycles)
8. On convergence: verifies (L0-L4 gates), creates PR, merges to main

**What you do:** Write specs (via interactive mode or manually) in `specs/`, run `/df:auto` inside Claude Code, read the report at `.deepflow/auto-report.md`. No need to run `/df:plan` first — auto mode promotes plain specs to `doing-*` automatically.

**How to use:**
```bash
# In Claude Code — create and approve a spec
$ claude
> /df:discover auth
> /df:spec auth          # creates specs/auth.md
> /exit

# Inside Claude Code — run auto mode
> /df:auto

# Next morning — check what happened
$ cat .deepflow/auto-report.md
$ git log --oneline
```

**Requires:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your environment (agent teams is an experimental Claude Code feature).

**Safety:** Never pushes to remote. Failed approaches recorded in `.deepflow/experiments/` and never repeated. Specs validated before processing (malformed specs are skipped).

### The Boundary

```
 YOU (the human)                    AI (autonomous)
 ─────────────────────────────────  ──────────────────────────────────
 Define the problem                 Generate hypotheses
 Write/approve the spec             Spike, implement, compare
 Set constraints & acceptance       Self-judge via adversarial selection
 criteria                           Verify against YOUR criteria
                                    Merge or retry
 Read morning report
 ─────────────────────────────────  ──────────────────────────────────
         specs/*.md is the handoff point
```

## The Flow (Interactive)

```
/df:discover <name>
    | Socratic questioning (motivation, scope, constraints...)
    v
/df:debate <topic>          <- optional
    | 4 perspectives: User Advocate, Tech Skeptic,
    |   Systems Thinker, LLM Efficiency
    | Creates specs/.debate-{topic}.md
    v
/df:spec <name>
    | Creates specs/{name}.md from conversation
    | Validates structure before writing
    v
/df:plan
    | Checks past experiments (learn from failures)
    | Risky work? -> generates spike task first
    | Creates PLAN.md with prioritized tasks
    | Renames: feature.md -> doing-feature.md
    v
/df:execute
    | Creates isolated worktree (main stays clean)
    | Spike tasks run first, verified before continuing
    | Parallel agents, file conflicts serialize
    | Context-aware (>=50% -> checkpoint)
    v
/df:verify
    | Checks requirements met
    | Merges worktree to main, cleans up
    | Extracts decisions -> .deepflow/decisions.md
    | Deletes done-* spec after extraction
```

## The Flow (Autonomous)

```
/df:auto
    | Discover specs (auto-promote, topological sort by depends_on)
    | For each doing-* spec:
    |
    |   Pre-check (Haiku: already satisfied? skip)
    |       v
    |   Validate spec (malformed? skip)
    |       v
    |   Generate N hypotheses
    |       v
    |   Parallel spikes (one worktree per hypothesis)
    |     | Pass? -> implement in same worktree
    |     | Fail? -> record experiment, discard
    |       v
    |   Adversarial selection (fresh context, artifacts only)
    |     | Winner? -> verify (L0-L4) -> PR -> merge
    |     | Reject all? -> new hypotheses, retry
    |       v
    |   Morning report -> .deepflow/auto-report.md
```

## Spec Lifecycle

```
specs/
  feature.md        -> new, needs /df:plan
  doing-feature.md  -> in progress (active contract between you and the AI)
  done-feature.md   -> transient (decisions extracted, then deleted)
```

## Works With Any Project

**Greenfield:** Everything is new, agents create from scratch.

**Ongoing:** Detects existing patterns, follows conventions, integrates with current code.

## Spike-First Planning

For risky or uncertain work, `/df:plan` generates a **spike task** first:

```
Spike: Validate streaming upload handles 10MB+ files
  | Run minimal experiment
  | Pass? -> Unblock implementation tasks
  | Fail? -> Record learning, generate new hypothesis
```

Experiments are tracked in `.deepflow/experiments/`. Failed approaches won't be repeated.

## Worktree Isolation

Execution happens in an isolated git worktree:
- Main branch stays clean during execution
- On failure, worktree preserved for debugging
- Resume with `/df:execute --continue`
- On success, `/df:verify` merges to main and cleans up

## LSP Integration

/df:automatically enables Claude Code's LSP tools during install, giving agents access to `goToDefinition`, `findReferences`, and `workspaceSymbol` for precise code navigation instead of grep-based searching.

- **Global install:** sets `ENABLE_LSP_TOOL=1` in `~/.claude/settings.json`
- **Project install:** sets it in `.claude/settings.local.json`
- **Uninstall:** cleans up automatically

Agents prefer LSP tools when available and fall back to Grep/Glob silently. You'll need a language server installed for your language (e.g. `typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`).

## Spec Validation

Specs are validated before downstream consumption by `/df:spec`, `/df:plan`, and `/df:auto`:

- **Hard invariants** (block on failure): required sections present, REQ-N prefixes, checkbox ACs, no duplicate IDs
- **Advisory warnings** (warn interactively, block in auto mode): long specs, orphaned requirements, excessive technical notes

Run manually: `node hooks/df-spec-lint.js specs/my-spec.md`

## Context-Aware Execution

Statusline shows context usage. At >=50%:
- Waits for running agents
- Checkpoints state
- Resume with `/df:execute --continue`

## Commands

| Command | Purpose |
|---------|---------|
| `/df:discover <name>` | Explore problem space with Socratic questioning |
| `/df:debate <topic>` | Multi-perspective analysis (4 agents) |
| `/df:spec <name>` | Generate spec from conversation |
| `/df:plan` | Compare specs to code, create tasks |
| `/df:execute` | Run tasks with parallel agents |
| `/df:verify` | Check specs satisfied, merge to main |
| `/df:note` | Capture decisions ad-hoc from conversation |
| `/df:consolidate` | Deduplicate and clean up decisions.md |
| `/df:resume` | Session continuity briefing |
| `/df:update` | Update deepflow to latest |
| `/df:auto` | Autonomous execution via agent teams (no human needed) |

## File Structure

```
your-project/
+-- specs/
|   +-- auth.md           # new spec
|   +-- doing-upload.md   # in progress
+-- PLAN.md               # active tasks
+-- .deepflow/
    +-- config.yaml            # project settings
    +-- decisions.md           # auto-extracted + ad-hoc decisions
    +-- auto-report.md         # morning report (autonomous mode)
    +-- auto-decisions.log     # AI decision log (autonomous mode)
    +-- last-consolidated.json # consolidation timestamp
    +-- context.json           # context % tracking
    +-- experiments/           # spike results (pass/fail)
    +-- worktrees/             # isolated execution
        +-- upload/            # one worktree per spec
```

## Configuration

Create `.deepflow/config.yaml`:

```yaml
project:
  source_dir: src/
  specs_dir: specs/

parallelism:
  execute:
    max: 5              # max parallel agents

worktree:
  cleanup_on_success: true
  cleanup_on_fail: false  # preserve for debugging
```

## Principles

1. **You define WHAT, AI figures out HOW** — Specs are the contract
2. **Confirm before assume** — Search code before marking "missing"
3. **Complete implementations** — No stubs, no placeholders
4. **Atomic commits** — One task = one commit
5. **Context-aware** — Checkpoint before limits

## License

MIT
