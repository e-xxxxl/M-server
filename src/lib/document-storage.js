import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Private storage for wallet documents, on this server's disk.
 *
 * - Every file is encrypted with AES-256-GCM before it is written, with a fresh random IV. The key lives only in the
 *   server's environment (DOCUMENT_ENCRYPTION_KEY, 32 bytes as base64). Anyone who copies the folder, a backup or a disk
 *   image gets unreadable bytes.
 * - The path is built only from a random hex key we generate. Nothing the client sends is ever part of a path, so there
 *   is nothing to traverse.
 * - Files are created with mode 0600 inside folders with mode 0700, and never inside the website or the release folder.
 * - Nothing here logs file contents, names or keys.
 */

const KEY_PATTERN = /^[0-9a-f]{32}$/;

export function createDocumentStorage(settings, { root = process.cwd() } = {}) {
  let key = null;
  try {
    const raw = Buffer.from(String(settings?.encryptionKey ?? ""), "base64");
    if (raw.length === 32) key = raw;
  } catch {
    key = null;
  }
  const base = path.resolve(root, settings?.dir ?? "storage/documents");

  const locate = (storageKey) => {
    if (!KEY_PATTERN.test(storageKey)) throw new Error("Invalid storage key");
    return { folder: path.join(base, storageKey.slice(0, 2)), file: path.join(base, storageKey.slice(0, 2), storageKey) };
  };

  return {
    enabled: key !== null,

    /** Encrypts and stores a file. Returns what must be kept to read it back. */
    async save(buffer) {
      if (!key) throw new Error("Document storage is not configured");
      const storageKey = crypto.randomBytes(16).toString("hex");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
      const tag = cipher.getAuthTag();
      const { folder, file } = locate(storageKey);
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, encrypted, { flag: "wx", mode: 0o600 });
      return { storageKey, iv: iv.toString("hex"), tag: tag.toString("hex") };
    },

    /** Reads and decrypts a file. Throws if the file is missing or has been changed. */
    async read({ storageKey, iv, tag }) {
      if (!key) throw new Error("Document storage is not configured");
      const encrypted = await fs.readFile(locate(storageKey).file);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
      decipher.setAuthTag(Buffer.from(tag, "hex"));
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    },

    /** Removes a file. A file that is already gone is not an error. */
    async remove(storageKey) {
      try {
        await fs.unlink(locate(storageKey).file);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    },
  };
}

// One storage for the process, set up once at start. Until then (and in tests) the wallet is off.
let current = createDocumentStorage(null);

export function configureDocumentStorage(config, options = {}) {
  current = createDocumentStorage(config.documents, options);
  return current;
}

/** Tests put a storage on a temporary folder here. */
export function setDocumentStorage(storage) {
  current = storage;
}

export const documentStorage = {
  get enabled() {
    return current.enabled;
  },
  save: (b) => current.save(b),
  read: (d) => current.read(d),
  remove: (k) => current.remove(k),
};
