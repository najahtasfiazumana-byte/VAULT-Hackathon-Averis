import fs from "node:fs/promises";
import path from "node:path";
import Dashboard from "@/components/Dashboard";
import { getDataDir } from "@/lib/attachments";
import type { EmailResult } from "@/lib/types";

export const dynamic = "force-dynamic";

async function loadReport(): Promise<{ generatedAt: string; model: string; results: EmailResult[] } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(getDataDir(), "report.json"), "utf8"));
  } catch {
    return null;
  }
}

export default async function Page() {
  const report = await loadReport();
  return <Dashboard report={report} />;
}
