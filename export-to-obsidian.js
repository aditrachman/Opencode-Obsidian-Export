// Plugin opencode: otomatis nyimpen isi sesi ke Obsidian tiap sesi "idle"
// (abis assistant jawab & nunggu input lagi). Karena di-key pake session ID,
// file-nya di-UPDATE terus di tempat yang sama, bukan numpuk duplikat.
//
// Setup:
//   1. Taruh file ini di ~/.config/opencode/plugin/export-to-obsidian.js
//   2. Set environment variable OBSIDIAN_VAULT_PATH ke path vault lo, misal
//      di ~/.bashrc: export OBSIDIAN_VAULT_PATH="/home/user/MyVault"
//   3. (Opsional) Set OPENCODE_ASSISTANT_NAME kalau mau label lain selain "Assistant"

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;
const LOG_SUBDIR = process.env.OBSIDIAN_LOG_SUBDIR || "OpenCode-Logs";
const ASSISTANT_NAME = process.env.OPENCODE_ASSISTANT_NAME || "Assistant";
const LOG_DIR = VAULT_PATH ? path.join(VAULT_PATH, LOG_SUBDIR) : null;

function sanitizeTitle(title) {
  return title
    .replace(/[\\/:*?"<>|]/g, "") // karakter yang gak boleh dipake di nama file
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
      return `> 🔧 pakai tool \`${p.tool}\` ${input}`;
    });
}

function messagesToMarkdown(session) {
  const info = session.info || {};
  const title = info.title || info.id || "Untitled Session";
  const sessionId = info.id || "unknown";
  const createdMs = info.time?.created || Date.now();

  const lines = [
    `# Raya-chan session: ${title}`,
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

    if (!text && toolNotes.length === 0) continue; // skip pesan kosong (step-start dll)

    lines.push(role === "user" ? "## 🧑 You" : `## 🤖 ${ASSISTANT_NAME}`);
    if (toolNotes.length) lines.push(...toolNotes, "");
    if (text) lines.push(text);
    lines.push("");
  }

  return { markdown: lines.join("\n"), title, sessionId, createdMs };
}

// Buang file lama punya sesi ini kalau judulnya berubah dari sebelumnya,
// biar gak numpuk file duplikat buat sesi yang sama.
async function removeOldFileForSession(sessionId, keepFilename) {
  const entries = await readdir(LOG_DIR).catch(() => []);
  for (const entry of entries) {
    if (entry.includes(`(${sessionId})`) && entry !== keepFilename) {
      await unlink(path.join(LOG_DIR, entry)).catch(() => {});
    }
  }
}

export const ExportToObsidian = async ({ project, directory }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const sessionId = event.properties?.sessionID || event.sessionID;
      if (!sessionId) return;

      if (!LOG_DIR) {
        console.error(
          "[export-to-obsidian] OBSIDIAN_VAULT_PATH belum di-set. " +
            "Set env var ini dulu (misal di ~/.bashrc), lalu restart opencode."
        );
        return;
      }

      try {
        const { stdout } = await execFileAsync("opencode", [
          "export",
          sessionId,
        ]);
        const session = JSON.parse(stdout);
        const { markdown, title, createdMs } = messagesToMarkdown(session);

        const dateStr = new Date(createdMs).toISOString().slice(0, 10); // YYYY-MM-DD
        const safeTitle = sanitizeTitle(title);
        const filename = `${dateStr} - ${safeTitle} (${sessionId}).md`;

        await mkdir(LOG_DIR, { recursive: true });
        await removeOldFileForSession(sessionId, filename);
        await writeFile(path.join(LOG_DIR, filename), markdown);
      } catch (err) {
        console.error("[export-to-obsidian] gagal export sesi:", err);
      }
    },
  };
};
