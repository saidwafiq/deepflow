# Approach B: Repo Inspection via WebFetch + gh api

## Objective
Inspect the repository https://github.com/huggingface/hf-mount and extract structured information about its purpose, architecture, and potential deepflow concepts.

## Constraints
- Use **ONLY** WebFetch and `gh api` commands (no Playwright, no local git clone)
- Fetch metadata via GitHub REST API
- Output must be valid JSON matching the specified schema

## Methodology

### Step 1: Gather Repository Metadata
Execute `gh api` command to fetch repository metadata:

```bash
gh api repos/huggingface/hf-mount
```

From this call, extract:
- Repository description
- Primary language
- Star count
- Topics/keywords
- Homepage URL
- Main branch name (typically "main" or "master")

### Step 2: Fetch README via WebFetch
Use WebFetch to retrieve the README content:
- URL: `https://github.com/huggingface/hf-mount/blob/main/README.md` OR `https://raw.githubusercontent.com/huggingface/hf-mount/main/README.md`
- Prompt: "Extract from this README: What problem does the project solve? What are the main features, architecture, and key components? List entry points and module names."

### Step 3: List Repository Contents via gh api
Fetch the root directory contents:

```bash
gh api repos/huggingface/hf-mount/contents/
```

And the src/ directory to identify entry points and key modules:

```bash
gh api repos/huggingface/hf-mount/contents/src
```

Analyze the file structure to identify:
- Entry points (main.rs, main.py, etc.)
- Key modules (directory names that suggest architecture)
- Overall project structure

### Step 4: Fetch Key Source Files via WebFetch (optional)
If helpful for understanding architecture, fetch 1-2 key files via WebFetch:
- Examples: `src/main.rs`, `Cargo.toml`, `pyproject.toml`, package.json
- Raw URLs: `https://raw.githubusercontent.com/huggingface/hf-mount/main/src/main.rs`
- Prompt: "What does this file do? What are the key entry points and modules it references?"

### Step 5: Analyze Dependencies via gh api + WebFetch
Fetch the dependency manifest file to count dependencies:

```bash
gh api repos/huggingface/hf-mount/contents/Cargo.toml
```

If Cargo.toml exists (Rust project), use WebFetch to retrieve it:
- URL: `https://raw.githubusercontent.com/huggingface/hf-mount/main/Cargo.toml`
- Prompt: "Count the total dependencies (both [dependencies] and [dev-dependencies]). List key dependencies that reveal the project's purpose."

Alternatively, for Python projects, fetch `requirements.txt` or `pyproject.toml`.

### Step 6: Synthesize Findings

Compile all gathered information into the JSON schema:

```json
{
  "repo": "huggingface/hf-mount",
  "purpose": "Clear one-sentence statement of what the repo does",
  "language": "Primary programming language(s)",
  "architecture": {
    "entry_points": ["List of main entry points (executables, CLI commands, main modules)"],
    "key_modules": ["Core modules and their responsibilities"],
    "patterns": ["Design patterns observed (FUSE, NFS, streaming, async, etc.)"]
  },
  "dependencies_count": "Total count of external dependencies",
  "files_inspected": ["List of files/URLs actually fetched or analyzed"],
  "concepts_for_deepflow": [
    "Concept 1: Brief explanation of how this could apply to deepflow",
    "Concept 2: ..."
  ],
  "confidence": 0.85
}
```

## Success Criteria
- All API calls and WebFetch operations complete successfully
- JSON is syntactically valid
- All required fields populated
- Confidence score reflects data quality (0.0–1.0)
- Concepts for deepflow are specific and actionable
- No local git clone, no Playwright usage
- files_inspected includes at least 3 URLs/files accessed

## Tool Usage Notes
- `gh api`: Used for metadata and file listing (no rate limit issues for public repos)
- `WebFetch`: Used for README, source files, and dependency manifests
- Combine API metadata with WebFetch text extraction for comprehensive understanding
