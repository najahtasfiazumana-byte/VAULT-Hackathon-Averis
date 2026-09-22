import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDataDir } from "@/lib/attachments";
import { processEmail } from "@/lib/pipeline";
import type { EmailRecord } from "@/lib/types";

export const maxDuration = 60;

/** Re-runs the whole pipeline live for one inbox email (used for retries and the live demo). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^email_\d+$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const email: EmailRecord = JSON.parse(await fs.readFile(path.join(getDataDir(), "inbox", `${id}.json`), "utf8"));
    return NextResponse.json(await processEmail(email));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
