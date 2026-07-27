// Plugin opencode: auto-save session ke Obsidian vault tiap session.idle
// Pakai: tinggal tambah "opencode-obsidian-export" ke plugin list di opencode.json
// Set env OBSIDIAN_VAULT_PATH ke path vault Obsidian lo, beres.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, appendFile, readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const PKG_NAME = "opencode-obsidian-export";
const PKG_VERSION = "1.0.0";

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

  return { vaultPath, logSubdir, userName, assistantName, sessionPrefix };
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

// Default maxBuffer Node cuma 1MB, gampang kepotong pas sesi panjang.
const EXPORT_MAX_BUFFER = 1024 * 1024 * 100; // 100MB

// ─── Helpers ────────────────────────────────────────────────────────────

function sanitizeTitle(title) {
  return title
    .replace(/[\\/:*?"<>|]/g, "") // karakter ilegal di filename
    .trim()
    .slice(0, 60);
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

function messagesToMarkdown(session, cfg) {
  const info = session.info || {};
  const title = info.title || info.id || "Untitled Session";
  const sessionId = info.id || "unknown";
  const createdMs = info.time?.created || Date.now();

  const lines = [
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
async function exportSession(sessionId) {
  const { stdout } = await execFileAsync("opencode", ["export", sessionId], {
    maxBuffer: EXPORT_MAX_BUFFER,
  });

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
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const sessionId = event.properties?.sessionID || event.sessionID;
      if (!sessionId) return;

      const currentCfg = getConfig();
      if (!currentCfg.vaultPath) return; // env var gak di-set, skip

      try {
        const session = await exportSession(sessionId);
        const { markdown, title, createdMs } = messagesToMarkdown(session, currentCfg);

        const dateStr = new Date(createdMs).toISOString().slice(0, 10);
        const safeTitle = sanitizeTitle(title);
        const filename = `${dateStr} - ${safeTitle}.md`;
        const logDir = resolveLogDir(currentCfg.vaultPath, currentCfg.logSubdir);

        await mkdir(logDir, { recursive: true });

        const index = await loadIndex();
        const previousFilename = index[sessionId];

        if (previousFilename && previousFilename !== filename) {
          await unlink(path.join(logDir, previousFilename)).catch(() => {});
        }

        await writeFile(path.join(logDir, filename), markdown);

        index[sessionId] = filename;
        await saveIndex(index);
      } catch (err) {
        await logToFile(`gagal export sesi: ${err?.stack || err}`);
      }
    },
  };
};
