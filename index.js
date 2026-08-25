// Plugin opencode: auto-save session ke Obsidian vault tiap session.idle
// Pakai: tinggal tambah "opencode-obsidian-export" ke plugin list di opencode.json
// Set env OBSIDIAN_VAULT_PATH ke path vault Obsidian lo, beres.

import { spawn } from "node:child_process";
import { writeFile, appendFile, readFile, mkdir, unlink, open, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { tool } from "@opencode-ai/plugin";

const PKG_NAME = "opencode-obsidian-export";
const PKG_VERSION = "1.1.0";

// Track the most-recently-active session so the manual `export_to_obsidian`
// tool knows which session to export when invoked without an explicit id.
let LAST_ACTIVE_SESSION_ID = null;

// ─── Config dari env var ────────────────────────────────────────────────
// WAJIB: OBSIDIAN_VAULT_PATH — path ke vault Obsidian
// Opsional:
//   OPENCODE_LOG_SUBDIR     — subfolder di vault (default: "OpenCode-Logs")
//   OPENCODE_USER_NAME      — label user di markdown   (default: "You")
//   OPENCODE_ASSISTANT_NAME — label assistant           (default: "Assistant")
//   OPENCODE_SESSION_PREFIX — prefix di judul note      (default: "Session")

function getConfig() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const logSubdir = process.env.OPENCODE_LOG_SUBDIR || "OpenCode-Logs";
  const userName = process.env.OPENCODE_USER_NAME || "You";
  const assistantName = process.env.OPENCODE_ASSISTANT_NAME || "Assistant";
  const sessionPrefix = process.env.OPENCODE_SESSION_PREFIX || "Session";
  // Filename format. Tokens: {date} {hostname} {title} {sessionId}
  // Default keeps the original "YYYY-MM-DD - <title>" behaviour.
  const filenameFormat =
    process.env.OPENCODE_FILENAME_FORMAT || "{date} - {title}";

  return {
    vaultPath,
    logSubdir,
    userName,
    assistantName,
    sessionPrefix,
    filenameFormat,
  };
}

function resolveLogDir(vaultPath, logSubdir) {
  // Expand ~/ kalau user pake path relatif home
  const resolved = vaultPath.startsWith("~")
    ? path.join(os.homedir(), vaultPath.slice(1))
    : vaultPath;

  return path.join(resolved, logSubdir);
}

// ─── Silent logging (ke file, bukan stdout/stderr) ──────────────────────
// Plugin ini sengaja gak pernah console.log/console.error ke terminal,
// karena `opencode export <id>` jalan di child process — stdout dipake
// buat nerima JSON. Console.log nyampur -> JSON.parse gagal.
// Stderr juga muncul di TUI opencode sebagai teks merah — ganggu.
// Semua log dialihin ke file .plugin.log di folder log vault.

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
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await appendFile(PLUGIN_LOG_FILE, line);
  } catch {
    // Logging gagal -> diemin, jangan bikin crash
  }
}

// ─── jsonrepair: optional, auto-fix JSON cacat ──────────────────────────
let jsonrepair = null;
try {
  ({ jsonrepair } = await import("jsonrepair"));
} catch {
  await logToFile(
    `${PKG_NAME}: library 'jsonrepair' gak ke-load. JSON auto-repair disabled. ` +
    "Ini bukan error — plugin tetap jalan normal."
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sanitizeTitle(title) {
  return title
    .replace(/[\\/:*?"<>|]/g, "") // karakter ilegal di filename
    .trim()
    .slice(0, 60);
}

// Build the note filename from a token template.
// Tokens: {date} {hostname} {title} {sessionId}. Always ends in ".md".
function buildFilename(format, tokens) {
  let name = format.replace(
    /\{(date|hostname|title|sessionId)\}/g,
    (_, k) => tokens[k] ?? ""
  );
  // Collapse whitespace/leftover separators from empty tokens.
  name = name.replace(/\s{2,}/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
  if (!name) name = tokens.title || tokens.sessionId || "session";
  if (!name.toLowerCase().endsWith(".md")) name += ".md";
  return name;
}

function extractText(parts) {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

function extractToolNotes(parts) {
  return parts
    .filter((p) => p.type === "tool")
    .map((p) => {
      const input = p.state?.input ? JSON.stringify(p.state.input) : "";
      return `> 🔧 tool: \`${p.tool}\` ${input}`;
    });
}

// ─── Agent-context extraction (add-on) ──────────────────────────────────
// The upstream plugin dumps the raw transcript. These helpers additionally
// distill a compact, agent-readable summary + highlights block so a FUTURE
// agent can @-load this note and resume work without re-deriving everything
// from scratch.

const YAML_ESCAPE = (s) =>
  typeof s === "string" && /[:#\-?\[\]{}&*!|>'"%@`\n]/.test(s)
    ? JSON.stringify(s)
    : s;

// Collect every distinct file path referenced by tool calls (read/edit/write).
function extractFilesTouched(session) {
  const files = new Set();
  const FILE_ARG_KEYS = ["filePath", "path", "file"];
  for (const msg of session.messages || []) {
    for (const p of msg.parts || []) {
      if (p.type !== "tool") continue;
      const input = p.state?.input || {};
      for (const k of FILE_ARG_KEYS) {
        if (typeof input[k] === "string") files.add(input[k]);
      }
    }
  }
  return [...files];
}

// Tally which tools were used, most-used first.
function extractToolUsage(session) {
  const counts = new Map();
  for (const msg of session.messages || []) {
    for (const p of msg.parts || []) {
      if (p.type !== "tool" || !p.tool) continue;
      counts.set(p.tool, (counts.get(p.tool) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Heuristic highlight extraction from assistant text: decisions, gotchas,
// TODOs, and warnings. Line-based — cheap, deterministic, no LLM needed.
const HIGHLIGHT_PATTERNS = [
  { tag: "decision", re: /\b(decided|chose|going with|we will|approach:|plan:)\b/i },
  { tag: "gotcha", re: /\b(gotcha|caveat|note that|be careful|important:|warning|caution|beware)\b/i },
  { tag: "todo", re: /\b(todo|follow-?up|next step|remaining|still need|not yet)\b/i },
  { tag: "fix", re: /\b(root cause|the bug|the issue was|fixed by|because)\b/i },
];

function extractHighlights(session, max = 12) {
  const out = [];
  for (const msg of session.messages || []) {
    if (msg.info?.role !== "assistant") continue;
    for (const p of msg.parts || []) {
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

// First substantive user message = the session's goal/intent.
function extractGoal(session) {
  for (const msg of session.messages || []) {
    if (msg.info?.role !== "user") continue;
    const text = extractText(msg.parts || []);
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

function buildAgentContext(session, cfg) {
  const info = session.info || {};
  const goal = extractGoal(session);
  const files = extractFilesTouched(session);
  const tools = extractToolUsage(session);
  const highlights = extractHighlights(session);
  const diff = info.summary || {};

  const fm = [
    "---",
    `session_id: ${YAML_ESCAPE(info.id || "unknown")}`,
    `title: ${YAML_ESCAPE(info.title || "")}`,
    `created: ${new Date(info.time?.created || Date.now()).toISOString()}`,
    `updated: ${new Date(info.time?.updated || Date.now()).toISOString()}`,
    `agent: ${YAML_ESCAPE(info.agent || "")}`,
    `model: ${YAML_ESCAPE(formatModel(info.model))}`,
    `directory: ${YAML_ESCAPE(info.directory || "")}`,
    `resume_cmd: ${YAML_ESCAPE(`opencode -s ${info.id || ""}`)}`,
    "tags: [opencode-session, agent-context]",
    "---",
    "",
  ];

  const ctx = ["## 🧭 Agent Context", ""];
  if (goal) ctx.push(`**Goal:** ${goal.replace(/\n/g, " ")}`, "");

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
    ctx.push(
      "**Tools used:** " + tools.map(([t, n]) => `${t}×${n}`).join(", "),
      ""
    );
  }

  if (typeof diff.additions === "number") {
    ctx.push(
      `**Diff stat:** +${diff.additions} / -${diff.deletions} across ${diff.files} file(s)`,
      ""
    );
  }

  ctx.push("---", "");
  return fm.join("\n") + ctx.join("\n");
}

function messagesToMarkdown(session, cfg) {
  const info = session.info || {};
  const title = info.title || info.id || "Untitled Session";
  const sessionId = info.id || "unknown";
  const createdMs = info.time?.created || Date.now();

  const lines = [
    buildAgentContext(session, cfg),
    `# ${cfg.sessionPrefix}: ${title}`,
    "",
    `session_id: ${sessionId}`,
    `created: ${new Date(createdMs).toISOString()}`,
    "",
    "---",
    "",
  ];

  for (const msg of session.messages || []) {
    const role = msg.info?.role || "unknown";
    const parts = msg.parts || [];
    const text = extractText(parts);
    const toolNotes = extractToolNotes(parts);

    if (!text && toolNotes.length === 0) continue;

    lines.push(
      role === "user"
        ? `## 🧑 ${cfg.userName}`
        : `## 🤖 ${cfg.assistantName}`
    );
    if (toolNotes.length) lines.push(...toolNotes, "");
    if (text) lines.push(text);
    lines.push("");
  }

  return { markdown: lines.join("\n"), title, sessionId, createdMs };
}

// ─── Session index (track mapping session → filename) ───────────────────
const INDEX_FILE_CACHE = new Map();

function getIndexFilePath() {
  const dir = ensureLogDir();
  if (!dir) return null;
  return path.join(dir, ".session-index.json");
}

async function loadIndex() {
  const indexPath = getIndexFilePath();
  if (!indexPath) return {};

  try {
    const raw = await readFile(indexPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveIndex(index) {
  const indexPath = getIndexFilePath();
  if (!indexPath) return;

  await writeFile(indexPath, JSON.stringify(index, null, 2));
}

// ─── Export session dari opencode CLI ───────────────────────────────────
// IMPORTANT: We spawn `opencode export` with stdout redirected to a TEMP FILE
// rather than capturing via a pipe (execFile). When this plugin runs *inside*
// a live opencode/openchamber instance, the nested `opencode export` child
// disposes its instance and exits before it finishes flushing a piped stdout,
// which silently TRUNCATES the JSON (e.g. ~63KB instead of ~740KB) — only the
// first handful of messages survive. Writing to a file has no pipe-buffer race,
// so we get the complete transcript. See regression: truncated Obsidian notes.
async function runExportToFile(sessionId) {
  const tmpPath = path.join(
    os.tmpdir(),
    `opencode-obsidian-export-${sessionId}-${Date.now()}.json`
  );
  const fh = await open(tmpPath, "w");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("opencode", ["export", sessionId], {
        stdio: ["ignore", fh.fd, "ignore"],
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`opencode export exited with code ${code}`))
      );
    });
  } finally {
    await fh.close();
  }
  return tmpPath;
}

async function exportSession(sessionId) {
  const tmpPath = await runExportToFile(sessionId);
  let stdout;
  try {
    stdout = await readFile(tmpPath, "utf-8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }

  // CLI kadang ngeprint teks lain ke stdout bareng JSON-nya.
  // Potong dari { pertama ke } terakhir biar sampah gak ikut ke parser.
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  const jsonSlice =
    firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
      ? stdout.slice(firstBrace, lastBrace + 1)
      : stdout;

  try {
    return JSON.parse(jsonSlice);
  } catch (firstErr) {
    // Coba repair kalo jsonrepair tersedia
    if (jsonrepair) {
      try {
        const repaired = jsonrepair(jsonSlice);
        const session = JSON.parse(repaired);
        await logToFile(
          `sesi ${sessionId}: JSON cacat, berhasil di-repair.`
        );
        return session;
      } catch {
        // lanjut ke dump
      }
    }

    // Dump stdout mentah buat debugging
    const dir = ensureLogDir();
    if (dir) {
      const debugPath = path.join(dir, `.debug-export-${sessionId}.txt`);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(debugPath, stdout ?? "");
        await logToFile(
          `sesi ${sessionId}: gagal parse (length: ${stdout?.length ?? 0}). Debug: ${debugPath}`
        );
      } catch (dumpErr) {
        await logToFile(
          `sesi ${sessionId}: gagal parse + gagal dump: ${dumpErr}`
        );
      }
    }
    throw firstErr;
  }
}

// ─── Shared: export one session → write note to vault ───────────────────
// Returns the absolute path of the written note (or null if skipped).
async function writeSessionNote(sessionId, cfg) {
  if (!cfg.vaultPath) return null;

  const session = await exportSession(sessionId);
  const { markdown, title, createdMs } = messagesToMarkdown(session, cfg);

  const dateStr = new Date(createdMs).toISOString().slice(0, 10);
  const safeTitle = sanitizeTitle(title);
  const filename = buildFilename(cfg.filenameFormat, {
    date: dateStr,
    title: safeTitle,
    hostname: sanitizeTitle(os.hostname().split(".")[0]),
    sessionId,
  });
  const logDir = resolveLogDir(cfg.vaultPath, cfg.logSubdir);

  await mkdir(logDir, { recursive: true });

  const index = await loadIndex();
  const previousFilename = index[sessionId];
  if (previousFilename && previousFilename !== filename) {
    await unlink(path.join(logDir, previousFilename)).catch(() => {});
  }

  const fullPath = path.join(logDir, filename);
  await writeFile(fullPath, markdown);

  index[sessionId] = filename;
  await saveIndex(index);

  return fullPath;
}

// ─── Plugin entry — dipanggil opencode ──────────────────────────────────

export const ExportToObsidian = async ({ project, directory }) => {
  // Validasi config di startup
  const cfg = getConfig();
  if (!cfg.vaultPath) {
    // Kita gak bisa console.error di sini karena bisa nyampur.
    // Log ke file doang.
    await logToFile(
      `${PKG_NAME} v${PKG_VERSION}: ERROR — OBSIDIAN_VAULT_PATH belum di-set!\n` +
      "Plugin aktif tapi gak bakal nulis apa-apa sampe env var di-set.\n" +
      `  Linux/Mac:  export OBSIDIAN_VAULT_PATH="/path/ke/vault"\n` +
      `  Windows:    $env:OBSIDIAN_VAULT_PATH = "C:\\Users\\...\\vault"\n` +
      "  (taruh di ~/.bashrc / PowerShell profile biar permanen)"
    );
  } else {
    await logToFile(
      `${PKG_NAME} v${PKG_VERSION} loaded. Logs → ${resolveLogDir(cfg.vaultPath, cfg.logSubdir)}`
    );
  }

  return {
    // Track the active session id so the manual tool can default to it.
    event: async ({ event }) => {
      const sid = event.properties?.sessionID || event.sessionID;
      if (sid) LAST_ACTIVE_SESSION_ID = sid;

      if (event.type !== "session.idle") return;
      if (!sid) return;

      const currentCfg = getConfig();
      if (!currentCfg.vaultPath) return; // env var gak di-set, skip

      try {
        await writeSessionNote(sid, currentCfg);
      } catch (err) {
        await logToFile(`gagal export sesi: ${err?.stack || err}`);
      }
    },

    // Manual export trigger. Lets the user/agent export on demand instead of
    // waiting for session.idle — e.g. "export this session to obsidian".
    tool: {
      export_to_obsidian: tool({
        description:
          "Export the current (or a specified) opencode session to the " +
          "Obsidian vault as a markdown note with an agent-context summary " +
          "(goal, highlights, files touched, tools used). Use when the user " +
          "asks to save/export/sync the session to Obsidian.",
        args: {
          sessionId: tool.schema
            .string()
            .optional()
            .describe(
              "Session id to export. Omit to export the current session."
            ),
        },
        async execute(args) {
          const currentCfg = getConfig();
          if (!currentCfg.vaultPath) {
            return (
              "OBSIDIAN_VAULT_PATH is not set — cannot export. " +
              'Set it, e.g. export OBSIDIAN_VAULT_PATH="/path/to/vault".'
            );
          }

          const sid = args.sessionId || LAST_ACTIVE_SESSION_ID;
          if (!sid) {
            return "No session id available yet. Pass sessionId explicitly.";
          }

          try {
            const written = await writeSessionNote(sid, currentCfg);
            return written
              ? `Exported session ${sid} → ${written}`
              : `Nothing written for session ${sid}.`;
          } catch (err) {
            await logToFile(`manual export gagal: ${err?.stack || err}`);
            return `Export failed for ${sid}: ${err?.message || err}`;
          }
        },
      }),
    },
  };
};
