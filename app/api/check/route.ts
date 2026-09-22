import { NextResponse } from "next/server";
import { loadBuffer, type LoadedDoc } from "@/lib/attachments";
import { checkDocuments } from "@/lib/pipeline";

export const maxDuration = 60;

async function fromForm(form: FormData, key: string): Promise<LoadedDoc | null> {
  const f = form.get(key);
  if (!(f instanceof File) || f.size === 0) return null;
  return loadBuffer(Buffer.from(await f.arrayBuffer()), f.name);
}

/** Live check: upload an SI and a BL (txt, pdf, scanned pdf, image, docx, xlsx) and get the discrepancy report. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const outcome = await checkDocuments(await fromForm(form, "si"), await fromForm(form, "bl"));
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
