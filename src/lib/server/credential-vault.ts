import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey() {
  const secret = process.env.SESSION_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("SESSION_TOKEN_ENCRYPTION_KEY or JWT_SECRET is not configured");
  }
  return createHash("sha256").update(secret).digest();
}

export function hashSessionCredential(credential: string) {
  return createHash("sha256").update(credential).digest("hex");
}

export function encryptSessionCredential(credential: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSessionCredential(payload: string) {
  const [version, ivText, tagText, ciphertextText] = payload.split(":");
  if (version !== VERSION || !ivText || !tagText || !ciphertextText) {
    throw new Error("Invalid encrypted session credential payload");
  }

  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function safeEqualCredentialHash(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
