import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveAttachmentPath } from "@/lib/attachments";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Serves a source attachment so reviewers can look at the evidence next to the extraction. */
export async function GET(req: Request) {
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  const full = resolveAttachmentPath(rel);
  if (!full) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  try {
    const buf = await fs.readFile(full);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream", "Content-Disposition": "inline" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
