import crypto from "node:crypto";
import fs from "node:fs";

export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function fileSha256(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

export function shortId(prefix: string, content: string): string {
  return `${prefix}-${sha256(content).slice(0, 12)}`;
}
