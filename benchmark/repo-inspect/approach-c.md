# Approach C: Repo Inspection via Local Clone & Filesystem Tools

## Objective
Inspect the repository https://github.com/huggingface/hf-mount by cloning it locally with shallow filters, then extract structured information about its purpose, architecture, and potential deepflow concepts using Read/Glob/Grep tools.

## Constraints
- Use `git clone --filter=blob:none --depth=1` for efficient shallow clone
- Clone destination: `/tmp/hf-mount-inspect`
- MUST clean up `/tmp/hf-mount-inspect` on exit (even if task fails)
- Use only local tools: Read, Glob, Grep
- Output must be valid JSON matching the specified schema
- No network requests to external APIs (only local filesystem inspection)

## Methodology

### Step 1: Clone Repository
Execute bash command to clone the repository:
```bash
git clone --filter=blob:none --depth=1 https://github.com/huggingface/hf-mount /tmp/hf-mount-inspect
```
- `--filter=blob:none`: Exclude file contents, fetch only tree structure (faster for inspection)
- `--depth=1`: Shallow clone of latest commit only
- Clones to `/tmp/hf-mount-inspect` for isolation

### Step 2: Discover Repository Structure
Use **Glob** to identify repository structure:
- Pattern: `**/*.md` — Find all markdown files (README, docs, etc.)
- Pattern: `**/*.toml` — Find Cargo.toml or other config files
- Pattern: `**/*.json` — Find package.json or similar
- Pattern: `**/src/**` — Map source code directories
- Limit results to 20 matches per pattern to identify entry points

### Step 3: Extract Dependencies & Project Metadata
Use **Read** to inspect key metadata files:
- Read `/tmp/hf-mount-inspect/Cargo.toml` (if Rust project) to extract dependencies count
- Read `/tmp/hf-mount-inspect/package.json` (if Node project) to extract dependencies count
- Read `/tmp/hf-mount-inspect/README.md` to understand purpose and features
- Read `/tmp/hf-mount-inspect/pyproject.toml` or `setup.py` (if Python project)
- Capture file contents for analysis

### Step 4: Inspect Source Code Entry Points
Use **Glob** to find entry point files:
- Pattern: `src/main.rs` — Rust entry point
- Pattern: `src/lib.rs` — Rust library root
- Pattern: `src/main.py` or `__main__.py` — Python entry point
- Pattern: `src/index.js` or `src/index.ts` — JavaScript/TypeScript entry point

Use **Read** to examine 2-3 key source files:
- Focus on discovering function/module names, key responsibilities
- Extract imports and module relationships
- Identify design patterns (async/await, traits, abstractions, etc.)

### Step 5: Identify Architectural Patterns
Use **Grep** to search for patterns (limit to 10 results per pattern):
- Pattern: `#\[derive\(` or similar macro patterns for trait-driven design
- Pattern: `impl\s+\w+\s+for` — Trait implementations
- Pattern: `async\s+fn` — Async patterns
- Pattern: `pub\s+mod|pub\s+struct|pub\s+enum` — Public API surface
- Pattern: `TODO|FIXME|XXX` — Development notes
- Focus on `src/` directory only

### Step 6: Count Dependencies
Parse manifest files using **Read**:
- Extract `[dependencies]` section from Cargo.toml (count lines) or dependencies from package.json
- Store count in JSON output

### Step 7: Synthesize Findings & Output JSON
Compile all gathered information into the JSON schema:

```json
{
  "repo": "huggingface/hf-mount",
  "purpose": "Clear one-sentence statement of what the repo does",
  "language": "Primary programming language (Rust, Python, JavaScript, etc.)",
  "architecture": {
    "entry_points": ["List of main entry points discovered (src/main.rs, bin/*, etc.)"],
    "key_modules": ["Core modules identified (e.g., mount, cache, protocol, etc.)"],
    "patterns": ["Design patterns observed (trait-based, async/await, plugin system, etc.)"]
  },
  "dependencies_count": 42,
  "files_inspected": [
    "/tmp/hf-mount-inspect/Cargo.toml",
    "/tmp/hf-mount-inspect/README.md",
    "/tmp/hf-mount-inspect/src/main.rs",
    "... other key files read or globbed"
  ],
  "concepts_for_deepflow": [
    "Concept 1: Brief explanation of how this could apply to deepflow",
    "Concept 2: ..."
  ],
  "confidence": 0.85
}
```

### Step 8: Cleanup
Execute bash command to remove cloned directory:
```bash
rm -rf /tmp/hf-mount-inspect
```
- **CRITICAL**: This must execute even if task fails (use try-finally pattern or explicit cleanup)
- Verify removal with `[ ! -d /tmp/hf-mount-inspect ] && echo "CLEANUP_SUCCESS"`

## Success Criteria
- Repository successfully cloned and inspected
- All glob patterns executed on local filesystem (no network calls)
- README, Cargo.toml/package.json, and 2+ source files read successfully
- Dependency count extracted and populated
- JSON output is syntactically valid
- All required fields populated with meaningful content
- Confidence score reflects data quality (0.0–1.0)
- Concepts for deepflow are specific and actionable
- Cleanup completed: `/tmp/hf-mount-inspect` directory removed
- Final output includes: `"cleanup_status": "success"`

## Implementation Notes
- Use `try-finally` or explicit cleanup logic to guarantee `/tmp/hf-mount-inspect` removal
- Glob patterns should use the full path `/tmp/hf-mount-inspect/**/*` to avoid relative path issues
- Read tool can handle large files, but focus on first 100 lines of source code
- Grep patterns target the `src/` subdirectory to avoid noise
- Dependencies count is numeric only (not string)
