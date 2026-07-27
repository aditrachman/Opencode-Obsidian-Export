# opencode-obsidian-export

[![npm version](https://badge.fury.io/js/opencode-obsidian-export.svg)](https://www.npmjs.com/package/opencode-obsidian-export)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Auto-save your [opencode](https://opencode.ai) chat sessions as readable Markdown notes in your Obsidian vault — every time a session goes idle, it's synced automatically. No manual export, no extra steps.

## Why

opencode already lets you resume a session with `opencode -s <session-id>`, but there's no easy way to *browse* or *search* your past conversations alongside your other notes. This plugin writes each session to your Obsidian vault as a normal `.md` file, so it shows up in Obsidian's native search, graph view, etc.

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
2. Extracts the actual conversation text (skips internal step/reasoning metadata)
3. Writes it to your vault as `YYYY-MM-DD - <title>.md`

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
