import { readFile, stat } from "fs/promises";
import path from "path";
import { contentTypeFromFilename, getUploadDir, safeUploadFilename } from "@/lib/server/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveUpload(filename: string) {
  const safeFilename = safeUploadFilename(filename);
  if (!safeFilename) return null;

  const uploadDir = path.resolve(getUploadDir());
  const absolutePath = path.resolve(uploadDir, safeFilename);
  const uploadDirWithSep = uploadDir.endsWith(path.sep) ? uploadDir : `${uploadDir}${path.sep}`;
  if (!absolutePath.startsWith(uploadDirWithSep)) return null;

  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return null;
    return {
      absolutePath,
      size: fileStat.size,
      lastModified: fileStat.mtime.toUTCString(),
      contentType: contentTypeFromFilename(safeFilename),
    };
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: { params: Promise<{ filename: string }> }) {
  const { filename } = await context.params;
  const upload = await resolveUpload(filename);
  if (!upload) return new Response("Not found", { status: 404 });

  const file = await readFile(upload.absolutePath);
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": upload.contentType,
      "Content-Length": String(upload.size),
      "Last-Modified": upload.lastModified,
      "Cache-Control": "public, max-age=60",
    },
  });
}

export async function HEAD(_request: Request, context: { params: Promise<{ filename: string }> }) {
  const { filename } = await context.params;
  const upload = await resolveUpload(filename);
  if (!upload) return new Response(null, { status: 404 });

  return new Response(null, {
    headers: {
      "Content-Type": upload.contentType,
      "Content-Length": String(upload.size),
      "Last-Modified": upload.lastModified,
      "Cache-Control": "public, max-age=60",
    },
  });
}