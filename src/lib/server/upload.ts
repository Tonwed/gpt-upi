import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const UPLOAD_URL_PREFIX = "/uploads";

export function getUploadDir() {
  const configured = process.env.UPLOAD_DIR;
  if (!configured) return path.join(process.cwd(), "public", "uploads");
  return path.isAbsolute(configured) ? configured : path.join(/*turbopackIgnore: true*/ process.cwd(), configured);
}

export function safeUploadFilename(filename: string) {
  const normalized = path.basename(filename.trim());
  if (!/^[0-9]+-[a-f0-9-]+\.(png|jpe?g|webp|gif)$/i.test(normalized)) return null;
  return normalized;
}

export function contentTypeFromFilename(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function extensionFromFile(file: File) {
  const nameExt = path.extname(file.name || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(nameExt)) return nameExt;
  if (file.type === "image/png") return ".png";
  if (file.type === "image/jpeg") return ".jpg";
  if (file.type === "image/webp") return ".webp";
  if (file.type === "image/gif") return ".gif";
  return ".png";
}

export async function saveQrUpload(file: File) {
  if (!file || file.size <= 0) {
    throw new Error("Please upload a QR code image");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("The QR code image cannot exceed 8MB");
  }
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    throw new Error("Only PNG, JPG, WEBP, and GIF images are supported");
  }

  const absoluteDir = getUploadDir();
  await mkdir(absoluteDir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID()}${extensionFromFile(file)}`;
  const absolutePath = path.join(absoluteDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);

  return `${UPLOAD_URL_PREFIX}/${filename}`;
}

export async function saveGeneratedQrPng(buffer: Buffer | Uint8Array) {
  if (!buffer || buffer.byteLength <= 0) {
    throw new Error("UPI QR image generation failed");
  }

  const absoluteDir = getUploadDir();
  await mkdir(absoluteDir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID()}.png`;
  const absolutePath = path.join(absoluteDir, filename);
  await writeFile(absolutePath, buffer);

  return `${UPLOAD_URL_PREFIX}/${filename}`;
}
