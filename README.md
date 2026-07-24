# opencode-obsidian-export

Auto-save your [opencode](https://opencode.ai) chat sessions as readable Markdown notes in your Obsidian vault — every time a session goes idle, it's synced automatically. No manual export, no extra steps.

## Why

opencode already lets you resume a session with `opencode -s <session-id>`, but there's no easy way to *browse* or *search* your past conversations alongside your other notes. This plugin closes that gap by writing each session to your Obsidian vault as a normal `.md` file, so it shows up in Obsidian's native search, graph view, etc.

## How it works

opencode's plugin system exposes a `session.idle` event, which fires whenever a session finishes responding and is waiting for the next input. This plugin listens for that event and:

1. Runs `opencode export <sessionID>` to get the session as JSON
2. Extracts the actual conversation text (skips internal step/reasoning metadata)
3. Writes it to your vault as `YYYY-MM-DD - <title> (<session-id>).md`

Because the file is keyed by session ID, re-syncing an ongoing conversation updates the same file instead of creating duplicates. The session ID stays in the filename so you can always jump back into the live session with `opencode -s <id>`.

## Setup

1. Copy `export-to-obsidian.js` to `~/.config/opencode/plugin/export-to-obsidian.js`
2. Set the vault path as an environment variable (e.g. in `~/.bashrc`):
   ```bash
   export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
   ```
3. (Optional) customize:
   ```bash
   export OBSIDIAN_LOG_SUBDIR="OpenCode-Logs"     # subfolder inside the vault, default shown
   export OPENCODE_ASSISTANT_NAME="Assistant"      # label used for assistant messages
   ```
4. Restart opencode. That's it — no build step, no dependencies beyond Node (which opencode already needs).

## Notes / gotchas

- The plugin does **not** use `opencode export --sanitize` — that flag redacts message content, which defeats the point of a readable log. This means secrets you paste into a session (API keys, etc.) will be saved in plaintext inside your vault. Don't paste secrets into chats you plan to sync, or exclude the log folder from any cloud sync / git repo.
- `session.idle` fires on every pause, not just when you close opencode — so logs update live throughout a conversation, not only at the end.
- This is plain-text history, not semantic search. If you want to *ask* your notes questions, that's a separate project (RAG over your vault) — out of scope here.

## License

MIT
