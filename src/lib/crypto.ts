import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

function key(): Buffer {
  return Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
}

/** Encrypts a secret with AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64 parts). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Decrypts a value produced by encryptSecret. Throws if it was tampered with. */
export function decryptSecret(enc: string): string {
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Invalid encrypted value format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Shows only the last 4 characters of a secret. Short values are fully hidden. */
export function maskSecret(plain: string): string {
  return plain.length >= 8 ? `••••${plain.slice(-4)}` : "••••";
}
