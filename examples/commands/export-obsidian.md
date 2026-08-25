---
description: Export the current opencode session to the Obsidian vault
agent: build
---

Export the CURRENT session to Obsidian using the `export_to_obsidian` tool.

First, write a concise narrative `summary` for the note so a future agent can resume without re-reading everything. Cover:
- **Goal** — what this session set out to do
- **What was done** — the actual changes/outcomes
- **Key decisions & gotchas** — anything non-obvious worth knowing
- **Current state** — what works / what's left
- **Next steps** — concrete follow-ups

Then call `export_to_obsidian` with that `summary` and no `sessionId` (defaults to the current session). Report back the exact file path it returns (or the error).

$ARGUMENTS
