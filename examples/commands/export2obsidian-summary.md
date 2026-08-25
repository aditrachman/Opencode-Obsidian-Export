---
description: Export a session SUMMARY note to the Obsidian vault
agent: build
---

Write a concise narrative `summary` of the CURRENT session, then call the `export_to_obsidian` tool with `transcript: false` to save a **summary-only** note (no full message dump) so a future agent can resume without re-reading everything.

Your `summary` should cover:
- **Goal** — what this session set out to do
- **What was done** — the actual changes/outcomes
- **Key decisions & gotchas** — anything non-obvious worth knowing
- **Current state** — what works / what's left
- **Next steps** — concrete follow-ups

Call `export_to_obsidian` with:
- `transcript: false`
- `summary`: <your narrative>
- no `sessionId` (defaults to the current session)

If the user supplied text below, treat it as a custom `filename` (tokens {date} {hostname} {title} {sessionId} are allowed). Otherwise omit `filename` and let it default to `<hostname> - <title> Summary.md`.

Report back the exact file path the tool returns.

$ARGUMENTS
