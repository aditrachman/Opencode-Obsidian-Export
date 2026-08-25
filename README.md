# opencode-obsidian-export

[![npm version](https://badge.fury.io/js/opencode-obsidian-export.svg)](https://www.npmjs.com/package/opencode-obsidian-export)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Auto-save your [opencode](https://opencode.ai) chat sessions as readable Markdown notes in your Obsidian vault — every time a session goes idle, it's synced automatically. Each note leads with an agent-readable summary (goal, highlights, files touched) so future agents can resume work without starting from scratch. Manual export on demand is supported too.

## Why

opencode already lets you resume a session with `opencode -s <session-id>`, but there's no easy way to *browse* or *search* your past conversations alongside your other notes. This plugin writes each session to your Obsidian vault as a normal `.md` file, so it shows up in Obsidian's native search, graph view, etc.

## Agent context (for resuming work)

On top of the raw transcript, each note now starts with an **Agent Context** block plus YAML frontmatter, so a *future* agent can `@`-load the note and pick up where the last one left off — without re-deriving everything from scratch:

- **Frontmatter:** `session_id`, `title`, `created`/`updated`, `agent`, `model`, `directory`, a ready-to-run `resume_cmd` (`opencode -s <id>`), and `tags: [opencode-session, agent-context]`.
- **Goal:** the first substantive user message (the intent of the session).
- **Highlights:** heuristically extracted lines tagged `decision` / `gotcha` / `todo` / `fix`.
- **Files touched:** every file path referenced by `read`/`edit`/`write` tool calls.
- **Tools used** and **diff stat** (`+adds / -dels across N files`).

This is deterministic and needs no LLM call — it's cheap line/tool analysis.

## Manual export

Exports still happen automatically on `session.idle`, but the plugin also registers a **tool** so you (or the agent) can export **on demand**.

It's not a slash-command or CLI keyword — it's a tool the agent calls. Just say something like:

> "export this session to obsidian"
> "save this session to my vault"
> "sync this chat to obsidian"

The agent recognizes the intent and invokes the `export_to_obsidian` tool. It takes an optional `sessionId` (defaults to the current session), so you can also export another session by id.

You can confirm the tool is loaded by asking the agent to *"list your available tools"* — `export_to_obsidian` should appear alongside the built-ins.

### Optional: a `/export-obsidian` slash command

Plain English works fine, but if you want a one-keystroke `/export-obsidian` in the TUI, add a command file. A command is just a markdown prompt template that tells the agent to call the tool — copy [`examples/commands/export-obsidian.md`](examples/commands/export-obsidian.md) into your commands dir:

```bash
# Global (all projects)
cp examples/commands/export-obsidian.md ~/.config/opencode/commands/

# …or per-project
mkdir -p .opencode/commands && cp examples/commands/export-obsidian.md .opencode/commands/
```

Then type `/export-obsidian` in the TUI. Under the hood it just asks the agent to invoke the `export_to_obsidian` tool for the current session — so the tool remains the source of truth; the command is only a convenience shortcut.

## Setup

### 1. Install (npm — recommended)

Add to your `opencode.json` (project root or `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-obsidian-export"]
}
```

Opencode auto-installs it with Bun. No manual `npm install` needed.

### 2. Set vault path

Tell the plugin where your Obsidian vault is:

**Linux / macOS** — tambah ke `~/.bashrc` atau `~/.zshrc`:
```bash
export OBSIDIAN_VAULT_PATH="/home/username/MyVault"
```

**Windows (PowerShell)** — tambah ke `$PROFILE`:
```powershell
$env:OBSIDIAN_VAULT_PATH = "C:\Users\Username\MyVault"
```

### 3. Restart opencode

Done. Sessions will auto-save to `<vault>/OpenCode-Logs/`.

---

### Manual install (no npm)

Alternatively, download `index.js` and place it in:

- **Linux / macOS:** `~/.config/opencode/plugin/index.js`
- **Windows:** `%APPDATA%\opencode\plugin\index.js` or `%USERPROFILE%\.config\opencode\plugin\index.js`

Then install the optional dependency (for auto-fixing malformed JSON):

```bash
cd ~/.config/opencode/plugin
npm install jsonrepair
```

## Custom labels

Set these env vars to customize the labels used in the generated markdown:

```bash
export OPENCODE_USER_NAME="You"            # 👤 user label (default: "You")
export OPENCODE_ASSISTANT_NAME="Assistant" # 🤖 assistant label (default: "Assistant")
export OPENCODE_SESSION_PREFIX="Session"   # 📝 title prefix (default: "Session")
export OPENCODE_LOG_SUBDIR="OpenCode-Logs" # 📁 subfolder in vault (default: "OpenCode-Logs")
```

### Filename format

By default notes are named `YYYY-MM-DD - <title>.md`. Customize it with a token template:

```bash
# Tokens: {date} {hostname} {title} {sessionId}
export OPENCODE_FILENAME_FORMAT="{hostname} - {title}"   # e.g. "Rvs-Mac-Mini - Fix auth bug.md"
```

Empty tokens and their leftover separators are cleaned up automatically, and `.md` is always appended.

`{hostname}` is your machine's short hostname (`os.hostname()` with the domain stripped) — handy when several machines sync into the same vault, so you can tell at a glance which box a session came from.

#### Multi-machine setup (`~/.zshrc` / `~/.bashrc`)

If you sync one Obsidian vault across machines (e.g. via Obsidian Sync, iCloud, Syncthing, or LiveSync) and want each machine's sessions grouped and labelled by host, add this block to your shell rc file:

```bash
# opencode → Obsidian session export
export OBSIDIAN_VAULT_PATH="$HOME/Brain"                 # path to your vault
export OPENCODE_LOG_SUBDIR="_Shared_Systems/Opencode"    # subfolder inside the vault
export OPENCODE_FILENAME_FORMAT="{hostname} - {title}"   # prefix notes with the machine name
```

Then reload and restart opencode:

```bash
source ~/.zshrc   # or: source ~/.bashrc
```

Every machine writes into the same `_Shared_Systems/Opencode/` folder, with filenames like `Rvs-Mac-Mini - Fix auth bug.md` and `Work-Laptop - Deploy pipeline.md`, so they never collide and are easy to filter in Obsidian search.

> Tip: check your machine's hostname first with `hostname -s` (macOS/Linux) so you know what the `{hostname}` token will resolve to.

Example — for a Raya-chan character setup:

```bash
export OPENCODE_USER_NAME="Tuan Adit"
export OPENCODE_ASSISTANT_NAME="Raya-chan"
export OPENCODE_SESSION_PREFIX="Raya-chan session"
export OPENCODE_LOG_SUBDIR="RayaChan-Logs"
```

## How it works

opencode's plugin system exposes a `session.idle` event, which fires whenever a session finishes responding and is waiting for the next input. This plugin listens for that event and:

1. Runs `opencode export <sessionID>` to get the session as JSON
2. Builds an **Agent Context** block (goal, highlights, files touched, tools, diff stat) + YAML frontmatter
3. Extracts the actual conversation text (skips internal step/reasoning metadata)
4. Writes it to your vault as `YYYY-MM-DD - <title>.md`

You can also trigger step 1–4 manually anytime via the `export_to_obsidian` tool.

Because the file is keyed by session ID (tracked via `.session-index.json`), re-syncing an ongoing conversation updates the same file instead of creating duplicates. Old files with different titles for the same session are cleaned up automatically.

## Important notes

- **Security:** Sessions are saved in plaintext. Don't paste secrets (API keys, passwords) into chats you plan to sync, or exclude the log folder from any cloud sync / git repo.
- **No TUI noise:** Plugin logs go to `.plugin.log` inside the log folder, not to the terminal — won't interfere with opencode's UI or `opencode export` stdout.
- **Large sessions safe:** `maxBuffer` is set to 100MB. Sessions with massive tool call outputs won't get truncated.
- **JSON repair:** If the export JSON is malformed (edge case), the plugin tries to auto-fix it using `jsonrepair` before giving up and dumping a debug file.
- This is plain-text history, not semantic search. If you want to *ask* your notes questions, that's a separate project (RAG over your vault) — out of scope here.

## File structure

```
<vault>/
└── OpenCode-Logs/
    ├── YYYY-MM-DD - Session Title.md   ← session notes
    ├── .session-index.json             ← tracks session → file mapping
    └── .plugin.log                     ← internal plugin logs
```

## Compatibility

- ✅ Linux
- ✅ macOS
- ✅ Windows
- ✅ opencode ≥ 0.x (plugin API)
- ✅ Node ≥ 18

## License

MIT — see [LICENSE](LICENSE).
