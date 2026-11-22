import fs from "fs";
import path from "path";

/*
  Shared crash-safe JSON file helpers.

  Writing JSON in place is what destroyed the lead store in production: the
  target file is truncated before the new bytes land, so a full disk or an
  interrupted process leaves a half-written file that JSON.parse rejects. Every
  write now goes to a temp file, is flushed, and is then renamed over the
  target, which is atomic on the same filesystem. Readers only ever observe the
  old file or the new one.

  The previous good file is kept as <file>.bak so a damaged file can be
  recovered instead of silently reverting to an empty dataset.
*/

export function parseJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readJsonWithBackup(filePath, fallback) {
  const primary = parseJsonFile(filePath);

  if (primary) return primary;

  const backupPath = `${filePath}.bak`;
  const backup = parseJsonFile(backupPath);

  if (backup) {
    console.error(`[json] ${path.basename(filePath)} is unreadable, recovered from backup`);
    return backup;
  }

  return typeof fallback === "function" ? fallback() : fallback;
}

export function writeJsonAtomic(filePath, data, { backup = true } = {}) {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = JSON.stringify(data, null, 2);

  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (backup && fs.existsSync(filePath) && parseJsonFile(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (err) {
      console.error(`[json] could not refresh ${path.basename(backupPath)}:`, err.message);
    }
  }

  fs.renameSync(tmpPath, filePath);

  return data;
}
