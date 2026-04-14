---
name: repo-inspect
description: Produces structured JSON intelligence for a remote GitHub repo — fetches metadata and file tree via gh api, reads key files via WebFetch. No local clone. Use when evaluating an unfamiliar repo before planning integration work.
context: fork
allowed-tools: [Bash, WebFetch]
---

# Repo-Inspect

Inspect a GitHub repository and emit a single JSON object describing its architecture. No clones, no tmpdir, no local filesystem writes.

**Input:** `{owner}/{repo}` or a full GitHub URL (e.g., `https://github.com/owner/repo`).
**Output:** Raw JSON only — no markdown, no commentary.

---

## Protocol

### Step 0 — Parse Input

Strip `https://github.com/` prefix if present. Extract `{owner}` and `{repo}` from the remaining `owner/repo` string.

### Step 1 — Fetch Repo Metadata (1 Bash call)

```bash
gh api repos/{owner}/{repo}
```

Extract: `description`, `language`, `topics`, `default_branch`, `stargazers_count`, `forks_count`.

On error (non-zero exit or JSON with `message` field indicating 404/403):
```json
{"error": "api_failed", "message": "<gh api error text>"}
```
Stop and return this error JSON immediately.

### Step 2 — Fetch Full File Tree (1 Bash call)

```bash
gh api "repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1"
```

Parse `tree[]` array. Each item has: `path`, `type` (`blob`|`tree`), `size`.

If tree is truncated (`truncated: true`), note it but proceed — the tree API returns up to ~100K entries which covers virtually all repos.

### Step 3 — Language Detection

Scan tree paths for manifest files in priority order:

| Manifest | Language |
|---|---|
| `Cargo.toml` | Rust |
| `package.json` | JavaScript/TypeScript |
| `pyproject.toml` or `setup.py` or `requirements.txt` | Python |
| `go.mod` | Go |
| `pom.xml` or `build.gradle` | Java |
| `mix.exs` | Elixir |
| `Gemfile` | Ruby |
| `build.zig` | Zig |
| `CMakeLists.txt` | C/C++ |

Use the **first match** (highest priority). If no manifest found, fall back to `language` field from Step 1 metadata.

Record: `detected_language`, `manifest_path` (path of matched manifest, or null).

### Step 4 — File Selection (3–6 files)

Build a prioritized list of files to fetch. Select 3–6 total:

1. **README** — find `README.md` or `README.rst` or `README` in tree root (depth 0). Always include if present.
2. **Manifest** — the manifest file detected in Step 3. Always include if present.
3. **Primary entry point** — search tree for (in order): `src/main.*`, `src/lib.*`, `src/index.*`, `index.*`, `app.*`, `main.*`. Pick the first match at the shallowest depth.
4. **Supplemental files** — from remaining blobs: prefer shallowest paths, then largest `size`. Pick source files (`.rs`, `.ts`, `.js`, `.py`, `.go`, `.java`, `.ex`, `.rb`, `.zig`, `.c`, `.cpp`, `.h`). Fill up to 6 total.

For monorepos (detected when tree contains `packages/*/`, `crates/*/`, `apps/*/` directories, or manifest workspace field): select 1-2 representative sub-package manifests/entry points instead of generic supplemental files.

### Step 5 — Fetch File Contents (3–6 WebFetch calls)

For each selected file path, fetch:

```
https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/{path}
```

Use WebFetch. If a fetch fails (404 or network error), skip that file and note it. Do not retry.

Collect: list of `{path, content}` pairs for all successfully fetched files.

### Step 6 — Extract Intelligence from Fetched Content

From manifest content (if fetched):

- **dependency_count**: Count entries in `[dependencies]` (Cargo.toml), `dependencies` + `devDependencies` keys (package.json), `[tool.poetry.dependencies]` (pyproject.toml), `require` directives (go.mod/Gemfile), `<dependency>` tags (pom.xml). Use 0 if manifest not fetched.
- **test_framework**: Check dev-dependencies for known test frameworks:
  - JS/TS: `jest`, `vitest`, `mocha`, `jasmine`, `tap`, `ava`
  - Python: `pytest`, `unittest` (stdlib), `nose`
  - Rust: built-in (`#[test]`), `rstest`, `proptest`
  - Go: built-in (`testing` package)
  - Java: `junit`, `testng`
  - Ruby: `rspec`, `minitest`
  - Elixir: built-in (`ExUnit`)
  Also check tree for `test/`, `tests/`, `spec/`, `__tests__/` directories as corroboration.
- **monorepo**: true if tree contains at least 2 of `packages/`, `crates/`, `apps/`, `libs/` top-level dirs, OR if manifest has workspace/workspaces field.

From README content (if fetched):
- Extract the first non-heading paragraph as a candidate for `purpose`. Trim to ≤ 200 chars.

Fallback for `purpose`: use repo `description` from Step 1 metadata.

### Step 7 — Derive key_modules

From the tree blob paths, identify directories containing 2+ source files (files with extensions `.rs`, `.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.go`, `.java`, `.ex`, `.rb`, `.zig`, `.c`, `.cpp`, `.h`, `.swift`, `.kt`).

Algorithm:
1. For each blob, extract parent directory path.
2. Count source files per directory.
3. Keep directories with count >= 2.
4. Sort by file count descending, then by path depth ascending (shallower = more significant).
5. Take up to 10 modules.
6. Strip common prefixes (e.g., if all modules share `src/`, keep `src/` as a module too).

Return directory names (last path segment) for the `key_modules` array. If fewer than 3 candidate directories exist, include directories with 1 source file to reach 3, or return what's available.

### Step 8 — Derive concepts_applicable

Based on language, test framework, monorepo status, and key module names, suggest applicable engineering concepts. Examples:

- Monorepo → `"workspace-management"`, `"cross-package-testing"`
- Rust → `"ownership-model"`, `"cargo-workspace"` (if monorepo)
- TypeScript → `"type-safety"`, `"module-resolution"`
- Has `auth` module → `"authentication-patterns"`
- Has `db` or `models` module → `"data-modeling"`
- Has `api` or `routes` module → `"rest-api-design"`
- Has tests → `"tdd"` or `"bdd"` (if rspec/jasmine)

Limit to 3–7 concepts. These are suggestions for the caller — not exhaustive.

### Step 9 — Confidence Score

Set `confidence` based on data quality:

| Condition | Confidence |
|---|---|
| README + manifest + entry point all fetched | `high` |
| README or manifest fetched, but not both | `medium` |
| Neither README nor manifest fetched | `low` |

### Step 10 — Emit JSON Output

Output **exactly one JSON object** with no surrounding text, no markdown code fences, no comments:

```json
{
  "repo": "{owner}/{repo}",
  "purpose": "<first non-heading README paragraph or repo description, ≤200 chars>",
  "architecture": {
    "language": "<detected language>",
    "entry_points": ["<relative paths of main/lib/index files>"],
    "key_modules": ["<directory names with 2+ source files>"],
    "dependencies_count": 0,
    "test_framework": "<framework name or 'unknown'>"
  },
  "concepts_applicable": ["<concept1>", "<concept2>"],
  "files_inspected": ["<path1>", "<path2>"],
  "confidence": "high|medium|low"
}
```

**Critical:** The very last thing you output must be this JSON object and nothing else. Do not wrap in code blocks. Do not add explanation.

---

## Error Handling

| Scenario | Action |
|---|---|
| `gh api` returns non-zero exit for metadata | Return `{"error": "api_failed", "message": "<stderr>"}` and stop |
| `gh api` returns 404 JSON | Return `{"error": "api_failed", "message": "Repository not found or not accessible"}` |
| Tree fetch fails | Return `{"error": "tree_failed", "message": "<stderr>"}` and stop |
| All WebFetch calls fail | Set confidence to "low", proceed with tree-only analysis |
| Single WebFetch fails | Skip file, continue |

---

## Efficiency Budget

- `gh api` calls: exactly 2 (metadata + tree)
- WebFetch calls: 3–6 (selected files)
- Analysis steps: ~5 (no extra Bash calls needed)
- **Total tool calls: ≤ 20**
- **Wall time: ≤ 60s**
- **Tokens: ≤ 30K**

Do not make extra `gh api` calls. Do not fetch files not in the selection list. The tree endpoint returns all paths in one call — no Glob, no Read, no additional listing needed.

---

## Rules

- Never write to local filesystem (no `> file`, no `mktemp`, no `git clone`).
- Never use Read, Glob, or Grep tools — this skill operates on remote data only.
- Output raw JSON only — the caller parses it, not reads it as prose.
- Private repos work automatically via `gh auth` stored token.
- Strip `context: fork` means this skill's token usage doesn't pollute the caller's context.
