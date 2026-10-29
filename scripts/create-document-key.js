// Prints a new key for the document wallet. Usage: npm run document-key
//
// It only prints. It never writes a file and never reads your .env, so nothing is stored by running it.
// Copy the line into the server's real .env (or Render's Environment settings). Keep a copy in your password manager:
// if the key is lost, every stored document becomes unreadable. Never change it while documents exist.
import crypto from "node:crypto";

const key = crypto.randomBytes(32).toString("base64");

console.log(`
Add these lines to the server's settings (the real .env, or Render > Environment):

DOCUMENT_ENCRYPTION_KEY=${key}
DOCUMENT_STORAGE_DIR=/var/lib/nmrep/documents

Notes:
- On your own computer you can leave DOCUMENT_STORAGE_DIR out: files go to backend/storage/documents.
- Keep a copy of the key in your password manager, separately from any backup of the files.
- If the key is lost, every stored document is lost. Do not change it while documents exist.
- On Render the disk is wiped on every deploy and restart unless you attach a paid persistent disk and point
  DOCUMENT_STORAGE_DIR at it. Use the VPS for real documents.
`);
