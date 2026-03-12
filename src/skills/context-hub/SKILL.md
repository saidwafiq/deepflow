---
name: context-hub
description: Fetches curated API docs for external libraries before coding. Use when implementing code that uses external APIs/SDKs (Stripe, OpenAI, MongoDB, etc.) to avoid hallucinating APIs and reduce token usage.
---

# Context Hub

Fetch curated, versioned docs for external libraries instead of guessing APIs.

## When to Use

Before writing code that calls an external API or SDK:
- New library integration (e.g., Stripe payments, AWS S3)
- Unfamiliar API version or method
- Complex API with many options (e.g., MongoDB aggregation)

**Skip when:** Working with internal code (use LSP instead) or well-known stdlib APIs.

## Prerequisites

Requires `chub` CLI: `npm install -g @aisuite/chub`

If `chub` is not installed, tell the user and skip — don't block implementation.

## Workflow

### 1. Search for docs

```bash
chub search "<library or API>" --json
```

Example:
```bash
chub search "stripe payments" --json
chub search "mongodb aggregation" --json
```

### 2. Fetch relevant docs

```bash
chub get <id> --lang <py|js|ts>
```

Use `--lang` matching the project language. Use `--full` only if the summary lacks what you need.

### 3. Write code using fetched docs

Use the retrieved documentation as ground truth for API signatures, parameter names, and patterns.

### 4. Annotate discoveries

When you find something the docs missed or got wrong:

```bash
chub annotate <id> "Note: method X requires param Y since v2.0"
```

This persists locally and appears on future `chub get` calls — the agent learns across sessions.

### 5. Rate docs (optional)

```bash
chub feedback <id> up --label accurate
chub feedback <id> down --label outdated
```

Labels: `accurate`, `outdated`, `incomplete`, `wrong-version`, `helpful`

## Integration with LSP

| Need | Tool |
|------|------|
| Internal code navigation | LSP (`goToDefinition`, `findReferences`) |
| External API signatures | Context Hub (`chub get`) |
| Symbol search in project | LSP (`workspaceSymbol`) |
| Library usage patterns | Context Hub (`chub search`) |

**Combined approach:** Use LSP to understand how the project currently uses a library, then use Context Hub to verify correct API usage and discover better patterns.

## Rules

- Always search before implementing external API calls
- Trust chub docs over training data for API specifics
- Annotate gaps so future sessions benefit
- Don't block on chub failures — fall back to best knowledge
- Prefer `--json` flag for programmatic parsing in automated workflows
