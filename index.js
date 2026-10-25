// opencode plugin: auto-save each session to an Obsidian vault on session.idle,
// plus a manual `export_to_obsidian` tool.
//
// Ported to the OpenCode v2 plugin API.
//   - v1 `event` hook          -> ctx.event.subscribe()
//   - v1 `tool` map            -> ctx.tool.transform()
//   - v1 `opencode export <id>`-> ctx.session.get() + ctx.session.context()
//
// Set OBSIDIAN_VAULT_PATH to your vault and you're done.
//
// NOTE: no `import { Plugin } from "@opencode/plugin"` here. Loose .js files in
// ~/.config/opencode/plugins/ have no node_modules beside them, so that import
// cannot resolve. Plugin.define is an identity function, so a plain default
// export of { id, setup } is equivalent.

import { writeFile, appendFile, readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PKG_NAME = "opencode-obsidian-export";
const PKG_VERSION = "2.0.0";

// ─── Config from env vars ───────────────────────────────────────────────
// REQUIRED: OBSIDIAN_VAULT_PATH
// Optional:
//   OPENCODE_LOG_SUBDIR       subfolder in the vault (default "OpenCode-Logs")
//   OPENCODE_USER_NAME        user label in markdown (default "You")
//   OPENCODE_ASSISTANT_NAME   assistant label        (default "Assistant")
//   OPENCODE_SESSION_PREFIX   note title prefix      (default "Session")
//   OPENCODE_FILENAME_FORMAT  tokens {date} {hostname} {title} {sessionId}

function getConfig() {
  return {
    vaultPath: process.env.OBSIDIAN_VAULT_PATH,
    logSubdir: process.env.OPENCODE_LOG_SUBDIR || "OpenCode-Logs",
    userName: process.env.OPENCODE_USER_NAME || "You",
    assistantName: process.env.OPENCODE_ASSISTANT_NAME || "Assistant",
    sessionPrefix: process.env.OPENCODE_SESSION_PREFIX || "Session",
    filenameFormat: process.env.OPENCODE_FILENAME_FORMAT || "{date} - {title}",
  };
}

function resolveLogDir(vaultPath, logSubdir) {
  const resolved = vaultPath.startsWith("~")
    ? path.join(os.homedir(), vaultPath.slice(1))
    : vaultPath;
  return path.join(resolved, logSubdir);
}

// ─── Silent logging (to file, never stdout/stderr) ──────────────────────
// Plugin output on stderr shows up in the TUI as red text. Keep it in a file.

let LOG_DIR = null;
let PLUGIN_LOG_FILE = null;

function ensureLogDir() {
  if (!LOG_DIR) {
    const cfg = getConfig();
    if (!cfg.vaultPath) return null;
    LOG_DIR = resolveLogDir(cfg.vaultPath, cfg.logSubdir);
    PLUGIN_LOG_FILE = path.join(LOG_DIR, ".plugin.log");
  }
  return LOG_DIR;
}

async function logToFile(message) {
  const dir = ensureLogDir();
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(PLUGIN_LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging must never break the plugin
  }
}

// ─── v2 shape normalisers ───────────────────────────────────────────────
// v1 messages looked like { info: { role }, parts: [...] } with tool parts
// keyed on `.tool`. v2 messages are flat: { type, content: [...] } with tool
// parts keyed on `.name`, and plain-text messages carrying `.text` directly.
// These readers accept either shape so the plugin survives further churn.

function msgRole(msg) {
  return msg?.type || msg?.info?.role || "unknown";
}

function msgParts(msg) {
  if (Array.isArray(msg?.content)) return msg.content;
  if (Array.isArray(msg?.parts)) return msg.parts;
  if (typeof msg?.text === "string" && msg.text) return [{ type: "text", text: msg.text }];
  return [];
}

function partToolName(part) {
  return part?.name || part?.tool || "";
}

function sessionDirectory(info) {
  return info?.location?.directory || info?.directory || "";
}

// Only real conversation goes into the note. v2 also emits system, synthetic,
// idle and agent-switched messages, which are machinery rather than dialogue.
const TRANSCRIPT_ROLES = new Set(["user", "assistant"]);

// Which events mean "the session stopped working". v2.1.x does not reliably
// emit `session.idle`; `session.status` (status.type = idle) and per-step
// `session.step.ended` are the signals that actually arrive. Exporting on the
// step boundary is harmless: the note is keyed by session id and rewritten.
function isIdleEvent(event) {
  const type = event?.type;
  if (type === "session.idle" || type === "session.step.ended") return true;
  if (type === "session.status") return event?.properties?.status?.type === "idle";
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sanitizeTitle(title) {
  return String(title)
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 60);
}

// Tokens: {date} {hostname} {title} {sessionId}. Always ends in ".md".
function buildFilename(format, tokens) {
  let name = format.replace(
    /\{(date|hostname|title|sessionId)\}/g,
    (_, k) => tokens[k] ?? ""
  );
  name = name.replace(/\s{2,}/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
  if (!name) name = tokens.title || tokens.sessionId || "session";
  if (!name.toLowerCase().endsWith(".md")) name += ".md";
  return name;
}

function extractText(parts) {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

function extractToolNotes(parts) {
  return parts
    .filter((p) => p.type === "tool")
    .map((p) => {
      const input = p.state?.input ? JSON.stringify(p.state.input) : "";
      return `> 🔧 tool: \`${partToolName(p)}\` ${input}`;
    });
}

// ─── Agent-context extraction ───────────────────────────────────────────
// Beyond the raw transcript, distill a compact summary so a FUTURE agent can
// @-load this note and resume without re-deriving everything.

const YAML_ESCAPE = (s) =>
  typeof s === "string" && /[:#\-?\[\]{}&*!|>'"%@`\n]/.test(s)
    ? JSON.stringify(s)
    : s;

const FILE_ARG_KEYS = ["filePath", "path", "file"];

function extractFilesTouched(messages) {
  const files = new Set();
  for (const msg of messages) {
    for (const p of msgParts(msg)) {
      if (p.type !== "tool") continue;
      const input = p.state?.input || {};
      for (const k of FILE_ARG_KEYS) {
        if (typeof input[k] === "string") files.add(input[k]);
      }
    }
  }
  return [...files];
}

function extractToolUsage(messages) {
  const counts = new Map();
  for (const msg of messages) {
    for (const p of msgParts(msg)) {
      if (p.type !== "tool") continue;
      const name = partToolName(p);
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Line-based heuristics: cheap, deterministic, no extra LLM call.
const HIGHLIGHT_PATTERNS = [
  { tag: "decision", re: /\b(decided|chose|going with|we will|approach:|plan:)\b/i },
  { tag: "gotcha", re: /\b(gotcha|caveat|note that|be careful|important:|warning|caution|beware)\b/i },
  { tag: "todo", re: /\b(todo|follow-?up|next step|remaining|still need|not yet)\b/i },
  { tag: "fix", re: /\b(root cause|the bug|the issue was|fixed by|because)\b/i },
];

function extractHighlights(messages, max = 12) {
  const out = [];
  for (const msg of messages) {
    if (msgRole(msg) !== "assistant") continue;
    for (const p of msgParts(msg)) {
      if (p.type !== "text" || !p.text) continue;
      for (const raw of p.text.split(/\n+/)) {
        const line = raw.trim().replace(/^[-*>#\s]+/, "");
        if (line.length < 12 || line.length > 240) continue;
        for (const { tag, re } of HIGHLIGHT_PATTERNS) {
          if (re.test(line)) {
            out.push({ tag, line });
            break;
          }
        }
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

// First substantive user message = the session's goal.
function extractGoal(messages) {
  for (const msg of messages) {
    if (msgRole(msg) !== "user") continue;
    const text = extractText(msgParts(msg));
    if (text) return text.slice(0, 400);
  }
  return "";
}

function formatModel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  const provider = model.providerID ? `${model.providerID}/` : "";
  return `${provider}${model.id || ""}`;
}

function formatTokens(tokens) {
  if (!tokens) return "";
  const cache = tokens.cache || {};
  const parts = [
    typeof tokens.input === "number" ? `in ${tokens.input}` : null,
    typeof tokens.output === "number" ? `out ${tokens.output}` : null,
    typeof tokens.reasoning === "number" && tokens.reasoning ? `reasoning ${tokens.reasoning}` : null,
    typeof cache.read === "number" && cache.read ? `cache-read ${cache.read}` : null,
    typeof cache.write === "number" && cache.write ? `cache-write ${cache.write}` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

function buildAgentContext(info, messages, cfg, opts = {}) {
  const goal = extractGoal(messages);
  const files = extractFilesTouched(messages);
  const tools = extractToolUsage(messages);
  const highlights = extractHighlights(messages);
  const diff = info.summary || {};
  const summary = typeof opts.summary === "string" ? opts.summary.trim() : "";

  const fm = [
    "---",
    `session_id: ${YAML_ESCAPE(info.id || "unknown")}`,
    `title: ${YAML_ESCAPE(info.title || goal.replace(/\s+/g, " ").slice(0, 60))}`,
    `created: ${new Date(info.time?.created || Date.now()).toISOString()}`,
    `updated: ${new Date(info.time?.updated || Date.now()).toISOString()}`,
    `agent: ${YAML_ESCAPE(info.agent || "")}`,
    `model: ${YAML_ESCAPE(formatModel(info.model))}`,
    `directory: ${YAML_ESCAPE(sessionDirectory(info))}`,
    `resume_cmd: ${YAML_ESCAPE(`opencode --session ${info.id || ""}`)}`,
    "tags: [opencode-session, agent-context]",
    "---",
    "",
  ];

  const ctx = ["## 🧭 Agent Context", ""];
  if (goal) ctx.push(`**Goal:** ${goal.replace(/\n/g, " ")}`, "");

  // Agent-written narrative summary, passed in via the export_to_obsidian
  // tool. Placed first so a future agent reads it before anything else.
  // Absent on automatic session.idle exports.
  if (summary) ctx.push("### 📝 Summary", "", summary, "");

  if (highlights.length) {
    ctx.push("**Highlights:**");
    for (const h of highlights) ctx.push(`- \`${h.tag}\` — ${h.line}`);
    ctx.push("");
  }

  if (files.length) {
    ctx.push("**Files touched:**");
    for (const f of files.slice(0, 30)) ctx.push(`- \`${f}\``);
    if (files.length > 30) ctx.push(`- …and ${files.length - 30} more`);
    ctx.push("");
  }

  if (tools.length) {
    ctx.push("**Tools used:** " + tools.map(([t, n]) => `${t}×${n}`).join(", "), "");
  }

  if (typeof diff.additions === "number") {
    ctx.push(
      `**Diff stat:** +${diff.additions} / -${diff.deletions} across ${diff.files} file(s)`,
      ""
    );
  }

  const tokenLine = formatTokens(info.tokens);
  if (tokenLine) ctx.push(`**Tokens:** ${tokenLine}`, "");
  if (typeof info.cost === "number" && info.cost > 0) {
    ctx.push(`**Cost:** $${info.cost.toFixed(4)}`, "");
  }

  ctx.push("---", "");
  return fm.join("\n") + ctx.join("\n");
}

function messagesToMarkdown(info, messages, cfg, opts = {}) {
  const title =
    info.title ||
    extractGoal(messages).replace(/\s+/g, " ").slice(0, 60) ||
    info.id ||
    "Untitled Session";
  const sessionId = info.id || "unknown";
  const createdMs = info.time?.created || Date.now();

  const lines = [buildAgentContext(info, messages, cfg, opts)];

  // Summary-only notes stop after the Agent Context block.
  if (opts.transcript === false) {
    return { markdown: lines.join("\n"), title, sessionId, createdMs };
  }

  lines.push(
    `# ${cfg.sessionPrefix}: ${title}`,
    "",
    `session_id: ${sessionId}`,
    `created: ${new Date(createdMs).toISOString()}`,
    "",
    "---",
    ""
  );

  for (const msg of messages) {
    const role = msgRole(msg);
    if (!TRANSCRIPT_ROLES.has(role)) continue;

    const parts = msgParts(msg);
    const text = extractText(parts);
    const toolNotes = extractToolNotes(parts);
    if (!text && toolNotes.length === 0) continue;

    lines.push(role === "user" ? `## 🧑 ${cfg.userName}` : `## 🤖 ${cfg.assistantName}`);
    if (toolNotes.length) lines.push(...toolNotes, "");
    if (text) lines.push(text);
    lines.push("");
  }

  return { markdown: lines.join("\n"), title, sessionId, createdMs };
}

// ─── Session index (session+kind → filename) ────────────────────────────

function getIndexFilePath() {
  const dir = ensureLogDir();
  return dir ? path.join(dir, ".session-index.json") : null;
}

async function loadIndex() {
  const indexPath = getIndexFilePath();
  if (!indexPath) return {};
  try {
    return JSON.parse(await readFile(indexPath, "utf-8"));
  } catch {
    return {};
  }
}

async function saveIndex(index) {
  const indexPath = getIndexFilePath();
  if (!indexPath) return;
  await writeFile(indexPath, JSON.stringify(index, null, 2));
}

// ─── Fetch a session through the plugin context ─────────────────────────
// v1 shelled out to `opencode export <id>`, which no longer exists in v2.

async function fetchSession(ctx, sessionID) {
  const [info, messages] = await Promise.all([
    ctx.session.get({ sessionID }),
    ctx.session.context({ sessionID }),
  ]);
  const resolvedInfo = info?.data || info || {};
  const resolvedMessages = messages?.data || messages || [];
  return {
    info: resolvedInfo,
    messages: Array.isArray(resolvedMessages) ? resolvedMessages : [],
  };
}

// ─── Export one session → write the note ────────────────────────────────
// Returns the absolute path written, or null when skipped.

async function writeSessionNote(ctx, sessionId, cfg, opts = {}) {
  if (!cfg.vaultPath) return null;

  const { info, messages } = await fetchSession(ctx, sessionId);
  const { markdown, title, createdMs } = messagesToMarkdown(info, messages, cfg, opts);

  const dateStr = new Date(createdMs).toISOString().slice(0, 10);
  const safeTitle = sanitizeTitle(title);

  // Summary and transcript notes for the SAME session must coexist rather
  // than overwrite each other, so the kind is part of both name and index key.
  const kind = opts.transcript === false ? "Summary" : "Transcript";
  const tokens = {
    date: dateStr,
    title: safeTitle,
    hostname: sanitizeTitle(os.hostname().split(".")[0]),
    sessionId,
  };

  let filename;
  if (opts.filename) {
    filename = buildFilename(String(opts.filename), tokens);
  } else {
    const base = buildFilename(cfg.filenameFormat, tokens).replace(/\.md$/i, "");
    filename = `${base} ${kind}.md`;
  }

  const logDir = resolveLogDir(cfg.vaultPath, cfg.logSubdir);
  await mkdir(logDir, { recursive: true });

  const indexKey = `${sessionId}::${kind}`;
  const index = await loadIndex();
  const previousFilename = index[indexKey];
  if (previousFilename && previousFilename !== filename) {
    await unlink(path.join(logDir, previousFilename)).catch(() => {});
  }

  const fullPath = path.join(logDir, filename);
  await writeFile(fullPath, markdown);

  index[indexKey] = filename;
  await saveIndex(index);

  return fullPath;
}

// ─── Plugin definition ──────────────────────────────────────────────────

export default {
  id: "obsidian-export",

  async setup(ctx) {
    const cfg = getConfig();
    if (!cfg.vaultPath) {
      await logToFile(
        `${PKG_NAME} v${PKG_VERSION}: OBSIDIAN_VAULT_PATH is not set. ` +
          "The plugin is loaded but will not write anything until it is.\n" +
          '  export OBSIDIAN_VAULT_PATH="/path/to/vault"'
      );
    } else {
      await logToFile(
        `${PKG_NAME} v${PKG_VERSION} loaded. Notes → ${resolveLogDir(cfg.vaultPath, cfg.logSubdir)}`
      );
    }

    // Manual export trigger, so the user or agent can export on demand
    // instead of waiting for session.idle.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "export_to_obsidian",
        description:
          "Export the current (or a specified) opencode session to the " +
          "Obsidian vault as a markdown note. Before calling, WRITE a concise " +
          "narrative `summary` of the session so a future agent can resume " +
          "without re-reading the whole transcript: what the goal was, what " +
          "was actually done, key decisions/gotchas, the current state, and " +
          "clear next steps. Use when the user asks to save/export/sync the " +
          "session to Obsidian.",
        input: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session id to export. Omit to export the current session.",
            },
            summary: {
              type: "string",
              description:
                "A concise narrative summary YOU (the agent) write for the " +
                "note's Agent Context block. Cover: goal, what was done, key " +
                "decisions/gotchas, current state, and next steps. Markdown " +
                "allowed. Omit only if there is genuinely nothing to summarize.",
            },
            transcript: {
              type: "boolean",
              description:
                "true (default) writes the full transcript note. false writes a " +
                "summary-only note (Agent Context block, no message dump).",
            },
            filename: {
              type: "string",
              description:
                "Optional filename override. Tokens {date} {hostname} {title} " +
                "{sessionId} are expanded; '.md' is added if missing.",
            },
          },
          additionalProperties: false,
        },
        async execute(input, toolContext) {
          const currentCfg = getConfig();
          if (!currentCfg.vaultPath) {
            return {
              content:
                "OBSIDIAN_VAULT_PATH is not set — cannot export. " +
                'Set it, e.g. export OBSIDIAN_VAULT_PATH="/path/to/vault".',
            };
          }

          const sid = input?.sessionId || toolContext?.sessionID;
          if (!sid) {
            return { content: "No session id available. Pass sessionId explicitly." };
          }

          try {
            const written = await writeSessionNote(ctx, sid, currentCfg, {
              summary: input?.summary,
              transcript: input?.transcript,
              filename: input?.filename,
            });
            return {
              content: written
                ? `Exported session ${sid} → ${written}`
                : `Nothing written for session ${sid}.`,
            };
          } catch (err) {
            await logToFile(`manual export failed: ${err?.stack || err}`);
            return { content: `Export failed for ${sid}: ${err?.message || err}` };
          }
        },
      });
    });

    // Auto-export whenever a session goes idle.
    const controller = new AbortController();
    const seenEventTypes = new Set();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = event?.type || "unknown";
          if (!seenEventTypes.has(type)) {
            seenEventTypes.add(type);
            await logToFile(`event received: ${type}`);
          }
          if (!isIdleEvent(event)) continue;

          const sid =
            event.properties?.sessionID ||
            event.data?.sessionID ||
            event.sessionID;
          if (!sid) {
            await logToFile(`${type} without sessionID: ${JSON.stringify(event)}`);
            continue;
          }

          const currentCfg = getConfig();
          if (!currentCfg.vaultPath) continue;

          try {
            const written = await writeSessionNote(ctx, sid, currentCfg);
            await logToFile(`auto export ok (${type}): ${sid} → ${written}`);
          } catch (err) {
            await logToFile(`auto export failed for ${sid}: ${err?.stack || err}`);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          await logToFile(`event stream ended: ${err?.stack || err}`);
        }
      }
    })();

    return () => controller.abort();
  },
};
