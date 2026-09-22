import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

/** Lazy: process.env.DATA_DIR is only read once .env.local has been loaded (Next.js does this
 *  automatically for the app; scripts do it themselves via loadEnvLocal()). A top-level
 *  `const DATA_DIR = ...` would freeze in the default before that load happens. */
export const getDataDir = () => process.env.DATA_DIR || path.join(process.cwd(), "data");

export type LoadedDoc =
  | { kind: "text"; text: string; format: string }
  | { kind: "binary"; mimeType: string; base64: string; format: string }
  | { kind: "error"; reason: string };

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** PDFs below this size cannot hold a real document (the corrupt samples are ~770 bytes). */
const MIN_PDF_BYTES = 1500;

export async function loadBuffer(buf: Buffer, filename: string): Promise<LoadedDoc> {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (!buf.length) return { kind: "error", reason: "file is empty" };

    if (ext === ".txt") {
      const text = buf.toString("utf8").trim();
      return text ? { kind: "text", text, format: "plain text" } : { kind: "error", reason: "text file is empty" };
    }
    if (ext === ".pdf") {
      if (buf.length < MIN_PDF_BYTES || !buf.subarray(0, 5).toString().startsWith("%PDF")) {
        return { kind: "error", reason: `PDF is ${buf.length} bytes and cannot contain a document (corrupt or truncated)` };
      }
      // Gemini reads both text PDFs and scanned/image-only PDFs natively.
      return { kind: "binary", mimeType: "application/pdf", base64: buf.toString("base64"), format: "PDF" };
    }
    if (IMAGE_MIME[ext]) {
      return { kind: "binary", mimeType: IMAGE_MIME[ext], base64: buf.toString("base64"), format: "image" };
    }
    if (ext === ".docx") {
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      const html = value.trim();
      return html ? { kind: "text", text: html, format: "Word document (HTML)" } : { kind: "error", reason: "Word document has no readable content" };
    }
    if (ext === ".xlsx" || ext === ".xls") {
      const wb = XLSX.read(buf, { type: "buffer" });
      const sheets = wb.SheetNames.map((n) => ({ n, csv: XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }) }));
      if (!sheets.some((x) => x.csv.replace(/[,\s]/g, "") !== "")) return { kind: "error", reason: "spreadsheet is empty" };
      const text = sheets.map((x) => `### Sheet: ${x.n}\n${x.csv}`).join("\n\n");
      return { kind: "text", text, format: "Excel sheet (CSV)" };
    }
    return { kind: "error", reason: `unsupported file type ${ext || "(none)"}` };
  } catch (e) {
    return { kind: "error", reason: `could not open file: ${(e as Error).message}` };
  }
}

export async function loadAttachment(relPath: string): Promise<LoadedDoc> {
  const full = resolveAttachmentPath(relPath);
  if (!full) return { kind: "error", reason: "invalid attachment path" };
  try {
    return await loadBuffer(await fs.readFile(full), relPath);
  } catch {
    return { kind: "error", reason: "attachment file not found" };
  }
}

/** Resolves an attachment path inside DATA_DIR/attachments only (no path traversal). */
export function resolveAttachmentPath(relPath: string): string | null {
  const dataDir = getDataDir();
  const full = path.resolve(dataDir, relPath);
  const root = path.resolve(dataDir, "attachments") + path.sep;
  return full.startsWith(root) ? full : null;
}
