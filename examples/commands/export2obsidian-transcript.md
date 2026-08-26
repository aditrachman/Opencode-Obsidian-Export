---
description: Export the FULL session transcript to the Obsidian vault
agent: build
---

Write a concise narrative `summary` of the CURRENT session, then call the `export_to_obsidian` tool with `transcript: true` to save the **full transcript** note (Agent Context block + every message) so it's browsable/searchable in Obsidian and a future agent can resume from it.

Your `summary` should cover:
- **Goal** — what this session set out to do
- **What was done** — the actual changes/outcomes
- **Key decisions & gotchas** — anything non-obvious worth knowing
- **Current state** — what works / what's left
- **Next steps** — concrete follow-ups

Call `export_to_obsidian` with:
- `transcript: true`
- `summary`: <your narrative>
- no `sessionId` (defaults to the current session)

If the user supplied text below, treat it as a custom `filename` (tokens {date} {hostname} {title} {sessionId} are allowed). Otherwise omit `filename` and let it default to `<hostname> - <title> Transcript.md`.

Report back the exact file path the tool returns.

$ARGUMENTS
