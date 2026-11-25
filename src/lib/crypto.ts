import crypto from "node:crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12 bytes recommended for AES-GCM

function getKeyBuffer(keyBase64?: string): Buffer {
  const raw = keyBase64 || env.DATA_ENCRYPTION_KEY;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`Invalid encryption key length: expected 32 bytes, got ${buf.length}`);
  }
  return buf;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: base64(iv).base64(authTag).base64(ciphertext)
 */
export function encrypt(plaintext: string, keyBase64?: string): string {
  const key = getKeyBuffer(keyBase64);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

/**
 * Decrypts a blob formatted as base64(iv).base64(authTag).base64(ciphertext).
 * Throws if tampered, corrupted, or invalid key.
 */
export function decrypt(encryptedBlob: string, keyBase64?: string): string {
  const parts = encryptedBlob.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted blob format: expected iv.tag.ciphertext");
  }

  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid IV length in encrypted blob");
  }

  const key = getKeyBuffer(keyBase64);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
