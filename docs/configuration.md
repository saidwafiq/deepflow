# Configuration

## Config File

Create `.deepflow/config.yaml` in your project root:

```yaml
project:
  name: my-project
  source_dir: src/
  specs_dir: specs/

planning:
  search_patterns:
    - "TODO"
    - "FIXME"
    - "stub"

parallelism:
  search:
    max: 100
  execute:
    max: 5

models:
  search: sonnet
  implement: sonnet
  reason: opus
```

## Options

### project

| Key | Default | Description |
|-----|---------|-------------|
| `name` | folder name | Project identifier |
| `source_dir` | `src/` | Where source code lives |
| `specs_dir` | `specs/` | Where specs are stored |

### planning

| Key | Default | Description |
|-----|---------|-------------|
| `search_patterns` | TODO, FIXME, etc. | Patterns indicating incomplete work |

### parallelism

Control agent spawning:

```yaml
parallelism:
  search:
    max: 100           # Maximum search agents
    per_files: 20      # 1 agent per N files
  analyze:
    max: 20
    per_specs: 2
  execute:
    max: 5             # Maximum parallel writers
    per_file: 1        # Never >1 agent on same file
  test:
    max: 1             # Always sequential
```

### models

Control which model handles what:

```yaml
models:
  search: sonnet       # Codebase scanning
  implement: sonnet    # Task implementation
  reason: opus         # Complex analysis
  debug: opus          # Problem diagnosis
```

### commits

```yaml
commits:
  format: "feat({spec}): {description}"
  atomic: true         # One task = one commit
  push_after: complete # "complete" or "each"
```

## Environment Variables

Some settings can come from environment:

```bash
export SPECFLOW_SOURCE_DIR=lib/
export SPECFLOW_MAX_AGENTS=50
```

Environment overrides config file.

## Per-Command Options

### /df:spec

```
/df:spec auth              # Normal
/df:spec auth --no-gaps    # Skip gap questions (you're sure)
```

### /df:plan

```
/df:plan                   # All specs
/df:plan --spec auth       # Single spec only
/df:plan --force           # Regenerate even if PLAN.md exists
```

### /df:execute

```
/df:execute                # All ready tasks
/df:execute T1 T2          # Specific tasks only
/df:execute --dry-run      # Show what would run
```

### /df:verify

```
/df:verify                 # All specs
/df:verify auth            # Single spec
/df:verify --strict        # Fail on any TODO/FIXME
```

## Defaults

If no config file exists, deepflow uses sensible defaults:

```yaml
project:
  source_dir: src/
  specs_dir: specs/

planning:
  search_patterns:
    - "TODO"
    - "FIXME"
    - "HACK"
    - "stub"
    - "placeholder"
    - "it.skip"
    - "test.skip"

parallelism:
  search:
    max: 50
  execute:
    max: 5

models:
  search: sonnet
  implement: sonnet
  reason: opus
```
