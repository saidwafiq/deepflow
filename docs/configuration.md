# Configuration

## Config File

Create `.deepflow/config.yaml` in your project root:

```yaml
project:
  name: my-project
  source_dir: src/
  specs_dir: specs/

parallelism:
  execute:
    max: 5              # max parallel agents

worktree:
  cleanup_on_success: true
  cleanup_on_fail: false  # preserve for debugging
```

## Options

### project

| Key | Default | Description |
|-----|---------|-------------|
| `name` | folder name | Project identifier |
| `source_dir` | `src/` | Where source code lives |
| `specs_dir` | `specs/` | Where specs are stored |

### parallelism

Control agent spawning during execution:

```yaml
parallelism:
  execute:
    max: 5             # Maximum parallel writer agents
```

### quality

Override auto-detected build and test commands:

```yaml
quality:
  build_command: "npm run build"
  test_command: "npm test"
  test_retry_on_fail: true   # re-run failed tests once (flaky detection)
```

#### Browser verification

Controls L5 browser verification, which launches a dev server and checks the UI in a headless browser after implementation. Automatically enabled when frontend dependencies (e.g. React, Vue, Next.js) are detected.

```yaml
quality:
  browser_verify: true        # true = always enable, false = always disable, absent = auto-detect
  dev_command: "npm run dev"  # override auto-detected dev server command
  dev_port: 3000              # port the dev server listens on (default: 3000)
  browser_timeout: 30         # seconds to wait for HTTP 200 before failing (default: 30)
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `browser_verify` | bool | auto-detect | `true` forces browser verification on; `false` disables it even when frontend deps are detected; omit to let deepflow decide |
| `dev_command` | string | from `package.json` scripts.dev | Command used to start the dev server |
| `dev_port` | number | `3000` | Port the dev server binds to |
| `browser_timeout` | number | `30` | Seconds to wait for the dev server to return HTTP 200 before marking verification as failed |

### worktree

```yaml
worktree:
  cleanup_on_success: true   # delete worktree after successful merge
  cleanup_on_fail: false     # preserve failed worktrees for debugging
```

### execution

Curator-orchestrator settings consumed by `/df:execute`:

```yaml
execution:
  max_consecutive_reverts: 3   # circuit breaker threshold per task
```

## Model Routing

Models are selected via `model:` field in agent/skill frontmatter. When no field is present, defaults to `sonnet`.

Currently:
- **Reasoner agent** (`model: opus`) — complex analysis, prioritization, architectural decisions
- **All other agents** — default to `sonnet`

## Per-Command Options

### /df:spec

```
/df:spec auth              # Normal
/df:spec auth --no-gaps    # Skip gap questions
```

### /df:execute

```
/df:execute                # All ready tasks
/df:execute T1 T2          # Specific tasks only
/df:execute --continue     # Resume from checkpoint
/df:execute --fresh        # Ignore checkpoint, start fresh
```

### /df:verify

```
/df:verify                 # All specs
/df:verify auth            # Single spec
/df:verify --strict        # Fail on any TODO/FIXME
```

## LSP Integration

The installer enables Claude Code's LSP tools, giving agents access to `goToDefinition`, `findReferences`, and `workspaceSymbol` for precise code navigation.

- **Global install:** sets `ENABLE_LSP_TOOL=1` in `~/.claude/settings.json`
- **Project install:** sets it in `.claude/settings.local.json`
- **Uninstall:** cleans up automatically

Agents prefer LSP tools when available and fall back to Grep/Glob silently. You'll need a language server installed for your language (e.g. `typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`).

## Spec Validation

Specs are validated before downstream consumption by `/df:spec` and `/df:execute`:

- **Hard invariants** (block on failure): required sections present, REQ-N prefixes, checkbox ACs, no duplicate IDs
- **Advisory warnings**: long specs, orphaned requirements, excessive technical notes (escalated to hard via `--strict`)

Run manually: `node hooks/df-spec-lint.js specs/my-spec.md`
