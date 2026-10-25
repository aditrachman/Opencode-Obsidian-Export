# opencode-obsidian-export

[![npm version](https://badge.fury.io/js/opencode-obsidian-export.svg)](https://www.npmjs.com/package/opencode-obsidian-export)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [opencode](https://opencode.ai) plugin that writes your chat sessions into an Obsidian vault as Markdown notes. Notes are saved automatically when a session goes idle, and you can export on demand as well.

Each note starts with a short context block: the session goal, extracted decisions and gotchas, the files that were touched, and the tools used. That block is meant to let a later session pick the work back up without rereading the whole transcript.

> Version 2.x targets the OpenCode v2 plugin API. On OpenCode v1, pin `opencode-obsidian-export@1.1.0`.

## Requirements

- OpenCode v2
- Node.js 18 or newer
- An Obsidian vault (any folder Obsidian has opened as a vault)

## Install

### 1. Add the plugin to your config

Edit `opencode.json` either in your project root or in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-obsidian-export"]
}
```

OpenCode installs the package itself when it starts. You do not need to run `npm install`.

### 2. Point the plugin at your vault

Set `OBSIDIAN_VAULT_PATH` in the shell that launches OpenCode.

Linux and macOS, in `~/.bashrc` or `~/.zshrc`:

```bash
export OBSIDIAN_VAULT_PATH="$HOME/Obsidian/MyVault"
```

Windows, in your PowerShell `$PROFILE`:

```powershell
$env:OBSIDIAN_VAULT_PATH = "C:\Users\You\MyVault"
```

Both an absolute path and a `~/...` path work.

### 3. Restart OpenCode

Notes will be written to `<vault>/OpenCode-Logs/`. Start a session, send a message, and the note for it should appear once the session goes idle.

If nothing is written, see [Troubleshooting](#troubleshooting).

### Manual install without npm

Download `index.js` and place it in the plugins directory:

- Linux and macOS: `~/.config/opencode/plugins/opencode-obsidian-export.js`
- Windows: `%APPDATA%\opencode\plugins\opencode-obsidian-export.js`

The file has no runtime dependencies. It deliberately does not import from `@opencode/plugin`, because a loose file in the plugins directory has no `node_modules` next to it and could not resolve that import.

## What gets written

By default each session produces one note, `YYYY-MM-DD - <title> Transcript.md`, containing:

1. YAML frontmatter with `session_id`, `title`, `created`, `updated`, `agent`, `model`, `directory`, `resume_cmd`, and tags.
2. An Agent Context block with the goal, optional summary, highlights, files touched, tools used, token usage, and cost.
3. The conversation itself, limited to user and assistant messages. OpenCode also emits `system`, `synthetic`, `idle`, and `agent-switched` messages; those are skipped.

A session at a given point in time looks roughly like this:

```markdown
---
session_id: ses_abc123
title: Fix the login redirect
created: 2026-10-24T08:12:03.401Z
updated: 2026-10-24T08:41:55.912Z
agent: build
model: anthropic/claude-sonnet-4
directory: /home/you/projects/app
resume_cmd: opencode --session ses_abc123
tags: [opencode-session, agent-context]
---

## 🧭 Agent Context

**Goal:** the redirect after login drops the return URL

**Highlights:**
- `decision` — going with a cookie instead of a query param
- `fix` — the bug was in the middleware order

**Files touched:**
- `src/auth/middleware.ts`

**Tools used:** read×4, edit×2

---
# Session: Fix the login redirect
```

The Agent Context block is built from heuristics. No language model is called for it, so it costs nothing and gives the same result for the same transcript. The one part that is not automatic is the prose summary, explained below.

### Summary notes vs transcript notes

Two kinds of notes can exist for one session:

| Kind | Contents | Default filename |
|---|---|---|
| Transcript | Context block plus every message | `<date> - <title> Transcript.md` |
| Summary | Context block only, no messages | `<date> - <title> Summary.md` |

Because the kind is part of the filename, both can exist side by side and neither overwrites the other.

## Usage

### Automatic export

The plugin listens for idle signals (`session.idle`, a `session.status` of type `idle`, or `session.step.ended`) and writes the transcript note for that session. A note is keyed by session id, so a later export updates the same file instead of creating duplicates. If the title changes and the filename changes with it, the old file is removed.

Automatic exports contain no prose section, because nothing writes one at that moment.

### Manual export from chat

The plugin registers a tool named `export_to_obsidian`. Ask for it in plain language:

> export this session to obsidian
>
> save this chat to my vault
>
> sync this session to obsidian

The agent calls the tool, which accepts:

- `sessionId` (optional, defaults to the current session)
- `summary` (optional narrative written by the agent, see below)
- `transcript` (defaults to `true`; `false` writes a summary-only note)
- `filename` (optional override, accepts the tokens listed below)

You can confirm the tool is loaded by asking the agent to list its tools. `export_to_obsidian` should be among them.

### Slash commands

Two commands are included in `examples/commands/`. They always ask the agent to write a summary first and then call the tool the same way, which makes the result more consistent than a free-form prompt.

| Command | Effect |
|---|---|
| `/export2obsidian-summary` | Writes a summary-only note |
| `/export2obsidian-transcript` | Writes the full transcript note |

Both accept an optional filename after the command, for example `/export2obsidian-summary {date} - {title}`.

Install both, then restart OpenCode:

```bash
mkdir -p ~/.config/opencode/commands
curl -fsSL https://raw.githubusercontent.com/aditrachman/Opencode-Obsidian-Export/main/examples/commands/export2obsidian-summary.md \
  -o ~/.config/opencode/commands/export2obsidian-summary.md
curl -fsSL https://raw.githubusercontent.com/aditrachman/Opencode-Obsidian-Export/main/examples/commands/export2obsidian-transcript.md \
  -o ~/.config/opencode/commands/export2obsidian-transcript.md
```

Command files are read at startup, so OpenCode has to be restarted before they show up.

### The summary section

OpenCode does not produce a prose summary of a session. When a manual export or a slash command runs, the agent writes one and passes it as the `summary` argument. The plugin places it in the note as `### 📝 Summary`, directly after the goal line.

The summary should cover the goal, what was actually changed, decisions and gotchas, the current state, and next steps. Nothing is generated when the argument is missing.

## Configuration

All configuration is through environment variables. Set them in the same shell that starts OpenCode.

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | none, required | Path to the vault |
| `OPENCODE_LOG_SUBDIR` | `OpenCode-Logs` | Subfolder inside the vault |
| `OPENCODE_USER_NAME` | `You` | Label used for user messages |
| `OPENCODE_ASSISTANT_NAME` | `Assistant` | Label used for assistant messages |
| `OPENCODE_SESSION_PREFIX` | `Session` | Prefix of the note title |
| `OPENCODE_FILENAME_FORMAT` | `{date} - {title}` | Base filename template |

### Filename tokens

`OPENCODE_FILENAME_FORMAT` and the `filename` argument accept:

- `{date}`: session date, `YYYY-MM-DD`
- `{hostname}`: short hostname of the machine
- `{title}`: session title, cleaned of characters Obsidian does not allow
- `{sessionId}`: full session id

Empty tokens and the separators left behind are removed, and `.md` is appended if missing.

The format sets the base name only. The plugin appends ` Summary` or ` Transcript` after it, so this:

```bash
export OPENCODE_FILENAME_FORMAT="{hostname} - {title}"
```

produces `work-laptop - Fix login Summary.md` and `work-laptop - Fix login Transcript.md`.

### Using one vault across several machines

If the vault is synced between machines, include `{hostname}` so notes do not collide and you can tell which machine a session came from:

```bash
export OBSIDIAN_VAULT_PATH="$HOME/Brain"
export OPENCODE_LOG_SUBDIR="_Shared_Systems/Opencode"
export OPENCODE_FILENAME_FORMAT="{hostname} - {title}"
```

Run `hostname -s` first if you want to see what the token will resolve to.

## Troubleshooting

Check `<vault>/<subdir>/.plugin.log` first. The plugin writes its own errors there instead of the terminal, so it does not draw over the OpenCode interface. The log records each event type it sees, every export with the resulting path, and the reason for any failure.

**Nothing is written and the log says the vault path is missing.**
`OBSIDIAN_VAULT_PATH` is not visible to OpenCode. Exporting the variable in a terminal does not affect a process started from a desktop launcher, so set it in the environment that actually starts OpenCode.

**The plugin never appears in the log.**
The entry in `opencode.json` is probably wrong. It belongs under `plugins`, not `plugin`.

**A note exists but is missing messages.**
Check the session in OpenCode first. Only user and assistant messages are written, and tool calls are summarized as blockquotes.

**The export tool is not available in chat.**
Restart OpenCode after changing the config. Plugins load at startup.

## How it works

1. On an idle event, the plugin reads the session with `ctx.session.get()` and `ctx.session.context()`.
2. It builds the frontmatter and the Agent Context block. The goal is the first non-empty user message, highlights come from pattern matching over assistant text, files come from tool arguments, and tool counts come from tool parts.
3. It filters the messages down to user and assistant roles and renders them as Markdown.
4. It writes the file and records the session-to-filename mapping in `.session-index.json`.

Only the note for the current session is rewritten. Past notes are not touched.

## Files in the vault

```
<vault>/
└── OpenCode-Logs/
    ├── 2026-10-24 - Fix login Summary.md
    ├── 2026-10-24 - Fix login Transcript.md
    ├── .session-index.json   session id to filename mapping
    └── .plugin.log           plugin log
```

## Notes and limits

- Notes are plain text. Do not paste secrets, API keys, or passwords into sessions you export, and keep the log folder out of any repository or sync you do not control.
- Large transcripts are read in process, not through a subprocess pipe, so there is no buffer limit that truncates them.
- This gives you readable history, not search by meaning. Asking questions across your vault needs a separate retrieval setup.
- The highlights and goal extraction are heuristics. Expect some noise in long sessions.

## Compatibility

- Linux, macOS, Windows
- OpenCode v2 (plugin API)
- Node.js 18 or newer

## License

MIT. See [LICENSE](LICENSE).
