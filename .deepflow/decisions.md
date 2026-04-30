# Decisions

### 2026-04-29 — fix-narrow-bash-per-agent

- [UPDATE] impl-class agents commit on their own df/<spec> branch — supersedes done-narrow-bash-per-agent REQ-2/AC-3; rationale: /df:execute mandates 1 task = 1 agent = 1 commit.
- [APPROACH] Convert AC-17 df-spike-platform tests to static SCOPES inspection (T10 salvage) — rationale: T9 dropped Tier-2 transcript-walk; df-spike-platform role has no Tier-1 path (TAG_TO_SUBAGENT lacks [SPIKE-PLATFORM]); static regex matching against SCOPES.allow/denyOverride verifies scope CONFIG, runtime behavior covered by integration once a real probe-T<N> worktree exists.
