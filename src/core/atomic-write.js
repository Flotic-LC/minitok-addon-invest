"use strict";

/**
 * Atomic file write with Windows NTFS fallback.
 *
 * Strategy:
 *   1. Write content to a temp file (pid + timestamp + random suffix)
 *   2. Try fs.renameSync (atomic on POSIX, usually atomic on NTFS)
 *   3. If rename fails with EPERM/EACCES (antivirus lock on Windows),
 *      fall back to copyFileSync + unlinkSync
 *   4. Verify the target file exists and has the expected size
 *
 * This prevents partial writes from corrupting state files when:
 *   - The process crashes mid-write (temp file is orphaned, target intact)
 *   - Antivirus briefly locks the temp file during rename
 *   - Disk is full (write to temp fails before target is touched)
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function tempPath(targetPath) {
  const rand = crypto.randomBytes(4).toString("hex");
  return `${targetPath}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

/**
 * Atomically write content to a file.
 * @param {string} filePath - Target file path
 * @param {string|Buffer} content - Content to write
 * @param {object} [options] - { encoding: "utf8", verify: true }
 * @returns {{ ok: boolean, method: "rename"|"copy", bytes: number, error?: string }}
 */
function atomicWriteFileSync(filePath, content, options = {}) {
  const { encoding = "utf8", verify = true } = options;
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmp = tempPath(filePath);
  const bytes = Buffer.byteLength(content, encoding);

  // Step 1: Write to temp file
  fs.writeFileSync(tmp, content, encoding);

  // Step 2: Try rename (atomic on POSIX)
  try {
    fs.renameSync(tmp, filePath);
    if (verify) {
      const stat = fs.statSync(filePath);
      if (stat.size !== bytes) {
        return { ok: false, method: "rename", bytes, error: `size mismatch: expected ${bytes}, got ${stat.size}` };
      }
    }
    return { ok: true, method: "rename", bytes };
  } catch (renameErr) {
    // Step 3: Fallback for Windows EPERM/EACCES (antivirus lock)
    if (renameErr.code === "EPERM" || renameErr.code === "EACCES" || renameErr.code === "EBUSY") {
      try {
        fs.copyFileSync(tmp, filePath);
        try { fs.unlinkSync(tmp); } catch { /* orphan cleanup — non-critical */ }
        if (verify) {
          const stat = fs.statSync(filePath);
          if (stat.size !== bytes) {
            return { ok: false, method: "copy", bytes, error: `size mismatch: expected ${bytes}, got ${stat.size}` };
          }
        }
        return { ok: true, method: "copy", bytes };
      } catch (copyErr) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
        return { ok: false, method: "copy", bytes, error: copyErr.message };
      }
    }
    // Non-recoverable rename failure
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    return { ok: false, method: "rename", bytes, error: renameErr.message };
  }
}

module.exports = { atomicWriteFileSync };
