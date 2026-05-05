---
name: df:update
description: Update or uninstall deepflow, check installed version
---

# /df:update — Update deepflow

**ACTION REQUIRED:** Run these two steps in order. Do NOT ask for confirmation — the user already confirmed by running `/df:update`.

## Step 1 — Install

```bash
npm install -g deepflow@latest && deepflow
```

Updates the global npm package, then runs the installer to refresh `~/.claude/`.

**Why not `npx deepflow@latest`?** Inside the Claude Code Bash sandbox, `npx`'s package-fetch step silently exits with code 194 and produces no output, leaving you unable to tell whether the install succeeded. `npm install -g` works reliably and the globally installed `deepflow` binary then runs the installer cleanly.

## Step 2 — Show what changed

After Step 1 succeeds:

Run this single command to read the installed version and slice the matching CHANGELOG block:

```bash
node -e '
const os = require("os"), https = require("https");
const v = require(os.homedir()+"/.claude/cache/df-update-check.json").currentVersion;
https.get("https://raw.githubusercontent.com/saidwafiq/deepflow/main/CHANGELOG.md", r => {
  let s=""; r.on("data",c=>s+=c); r.on("end",()=>{
    const start = s.indexOf("## v"+v+" ");
    let block = "(no CHANGELOG entry found)";
    if (start >= 0) {
      const next = s.indexOf("\n## v", start+1);
      block = (next >= 0 ? s.slice(start, next) : s.slice(start)).trim();
    }
    process.stdout.write("VERSION="+v+"\n---\n"+block+"\n");
  });
});'
```

Then present a **2–4 bullet summary** of what changed in this release, written from the user's perspective ("You can now…", "Fixed…"). Reference concrete commands or behaviours the user will see, not git internals. End with the GitHub release URL: `https://github.com/saidwafiq/deepflow/releases/tag/v<VERSION>`.

If the CHANGELOG fetch fails or the version block isn't found, just report `✓ updated to v<VERSION>` and skip the summary — don't fabricate release notes.

## Uninstall

To uninstall instead, run:

```bash
deepflow --uninstall
```

## Check Version

```bash
# Installed version (source of truth):
cat ~/.claude/cache/df-update-check.json | grep currentVersion

# Latest on npm:
npm view deepflow version
```

**NOTE:** Do NOT use `npm list -g deepflow` — it shows a stale version unrelated to the actual installation.
