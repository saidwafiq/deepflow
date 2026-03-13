```

 ██████╗  ███████╗ ███████╗ ██████╗      ███████╗ ██╗       ██████╗  ██╗    ██╗
 ██╔══██╗ ██╔════╝ ██╔════╝ ██╔══██╗     ██╔════╝ ██║      ██╔═══██╗ ██║    ██║
 ██║  ██║ █████╗   █████╗   ██████╔╝     █████╗   ██║      ██║   ██║ ██║ █╗ ██║
 ██║  ██║ ██╔══╝   ██╔══╝   ██╔═══╝      ██╔══╝   ██║      ██║   ██║ ██║███╗██║
 ██████╔╝ ███████╗ ███████╗ ██║          ██║      ███████╗ ╚██████╔╝ ╚███╔███╔╝
 ╚═════╝  ╚══════╝ ╚══════╝ ╚═╝          ╚═╝      ╚══════╝  ╚═════╝   ╚══╝╚══╝ 

```

<p align="center">
  <strong>Doing reveals what thinking can't predict</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#two-modes">Two Modes</a> •
  <a href="#commands">Commands</a> •
  <a href="#what-deepflow-rejects">What It Rejects</a> •
  <a href="#principles">Principles</a>
</p>

---

## Why Deepflow

**You can't foresee what you don't know to ask.** Doing reveals — at every layer.

Most spec-driven frameworks start from a finished spec and execute a static plan. Deepflow treats the entire process as discovery: asking reveals hidden requirements, debating reveals blind spots, spiking reveals technical risks, implementing reveals edge cases. Each step makes the next one sharper.

- **Asking reveals what assuming hides** — Before any code, Socratic questioning surfaces the requirements you didn't know you had. Four AI perspectives collide to expose tensions in your approach. The spec isn't written from what you think you know — it's written from what the conversation uncovered.
- **Spec as living hypothesis** — Core intent stays fixed, details refine through implementation. "The spec becomes bulletproof because you built it, not before."
- **Parallel probes reveal the best path** — Uncertain approaches spawn parallel spikes in isolated worktrees. The machine selects the winner (fewer regressions > better coverage > fewer files changed). Failed approaches stay recorded and never repeat.
- **Metrics decide, not opinions** — No LLM judges another LLM. Build, tests, typecheck, lint are the only judges. After an agent commits, the orchestrator runs health checks. Pass = keep. Fail = revert + new hypothesis.
- **The loop is the product** — Not "execute a plan" — "evolve the codebase toward the spec's goals through iterative cycles." Each cycle reveals what the previous one couldn't see.

## What We Learned by Doing

Deepflow started with adversarial selection: one AI evaluated another AI's code in a fresh context. The "doing reveals" philosophy applied to the system itself — we discovered that **LLM judging LLM produces gaming**: agents that estimated instead of measuring, simulated instead of implementing, presented shortcuts as deliverables.

The fix: eliminate subjective judgment. Only objective metrics decide. Tests created by the agent itself are excluded from the baseline to prevent self-validation. We call this a **ratchet** — inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch): a mechanism where the metric can only improve, never regress. Each cycle ratchets quality forward.

## Quick Start

```bash
# Install (or update)
npx deepflow

# Uninstall
npx deepflow --uninstall
```

The installer configures granular permissions so background agents can read, write, run git, and execute health checks (build/test/typecheck/lint) without blocking on approval prompts. All permissions are scoped and cleaned up on uninstall.

## Two Modes

### Interactive (human-in-the-loop)

You explore the problem, shape the spec, and trigger execution — all inside a Claude Code session.

```bash
claude

# 1. Discover — understand the problem before solving it
/df:discover image-upload
#    "Why do you need image upload? What exists today?
#     What file sizes? What formats? Where are images stored?
#     What does 'done' look like? What should this NOT do?"

# 2. Debate — stress-test the approach (optional)
/df:debate upload-strategy
#    User Advocate:   "Drag-and-drop is table stakes, not a feature"
#    Tech Skeptic:    "Client-side resize before upload, or you'll hit memory limits"
#    Systems Thinker: "What happens when storage goes down mid-upload?"
#    LLM Efficiency:  "Split this into two specs: upload + processing"

# 3. Spec — now the conversation is rich enough to produce a solid spec
/df:spec image-upload

# 4-6: the AI takes over
/df:plan                         # Compare spec to code, create tasks
/df:execute                      # Parallel agents in worktree, ratchet validates
/df:verify                       # Check spec satisfied, merge to main
```

**What requires you:** Steps 1-3 (defining the problem and approving the spec). Steps 4-6 run autonomously but you trigger each one and can intervene.

### Autonomous (unattended)

The human loop comes first — discover and debate are where intent gets shaped. You refine the problem, stress-test ideas, and produce a spec that captures what you actually need. That's the living contract. Then you hand it off.

```bash
# First: the human loop — discover, debate, refine until the spec is solid
$ claude
> /df:discover auth
> /df:debate auth-strategy
> /df:spec auth              # specs/auth.md — the handoff point
> /exit

# Then: the AI loop — plan, execute, validate, merge
$ claude
> /df:auto

# Next morning
$ cat .deepflow/auto-report.md
$ git log --oneline
```

**What the AI does alone:**
1. Runs `/df:plan` if no PLAN.md exists
2. Snapshots pre-existing tests (ratchet baseline)
3. Starts a loop (`/loop 1m /df:auto-cycle`) — fresh context each cycle
4. Each cycle: picks next task → executes in worktree → runs health checks (build/tests/typecheck/lint)
5. Pass = commit stands. Fail = revert + retry next cycle
6. Circuit breaker: halts after N consecutive reverts on same task
7. When all tasks done: runs `/df:verify`, merges to main

**Safety:** Never pushes to remote. Failed approaches recorded in `.deepflow/experiments/` and never repeated. Specs validated before processing.

### Two Loops, One Handoff

```
 HUMAN LOOP                         AI LOOP
 ─────────────────────────────────  ──────────────────────────────────
 /df:discover — ask, surface gaps   /df:plan — compare spec to code
 /df:debate — stress-test approach  /df:execute — spike, implement
 /df:spec — produce living contract /df:verify — health checks, merge
      ↻ refine until solid               ↻ retry until converged
 ─────────────────────────────────  ──────────────────────────────────
         specs/*.md is the handoff point
```

**Spec lifecycle:** `feature.md` (new) → `doing-feature.md` (in progress) → `done-feature.md` (decisions extracted, then deleted)

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
| `/df:auto` | Autonomous mode (plan → loop → verify, no human needed) |

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
    +-- auto-memory.yaml       # cross-cycle learning
    +-- experiments/           # spike results (pass/fail)
    +-- worktrees/             # isolated execution
        +-- upload/            # one worktree per spec
```

## What Deepflow Rejects

- **Predicting everything before doing** — You discover what you need by building it. TDD assumes you already know the correct behavior before coding. Deepflow assumes that **execution reveals** what planning can't anticipate.
- **LLM judging LLM** — We started with adversarial selection (AI evaluating AI). We discovered gaming. We replaced it with objective metrics. Deepflow's own evolution proved the principle.
- **Agents role-playing job titles** — Flat orchestrator + model routing. No PM agent, no QA agent, no Scrum Master agent.
- **Automated research before understanding** — Conversation with you first. AI research comes after you've defined the problem.
- **Ceremony** — 6 commands, one flow. Markdown, not schemas. No sprint planning, no story points, no retrospectives.

## Principles

1. **Discover before specifying, spike before implementing** — Ask, debate, probe — then commit
2. **You define WHAT, AI figures out HOW** — Specs are the contract
3. **Metrics decide, not opinions** — Build/test/typecheck/lint are the only judges
4. **Confirm before assume** — Search the code before marking "missing"
5. **Complete implementations** — No stubs, no placeholders
6. **Atomic commits** — One task = one commit
7. **Context-aware** — Checkpoint before limits, resume seamlessly

## More

- [Concepts](docs/concepts.md) — Philosophy and flow in depth
- [Configuration](docs/configuration.md) — All options, models, parallelism

## License

MIT
