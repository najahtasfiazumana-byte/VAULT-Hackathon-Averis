/**
 * Batch pipeline: inbox -> classify -> (BL_COMPARISON only) extract + compare -> report.
 *
 *   npm run batch                       # everything, resumable (results cached in .cache/)
 *   npm run batch -- --only email_004,email_512
 *   (failures are not cached, so simply re-running retries only the emails that failed)
 *   npm run batch -- --fresh            # ignore the cache
 *
 * Writes data/report.json (used by the dashboard) and submission.json (self-evaluation format).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { classifyEmails, checkEmail, cleanBody } from "../lib/pipeline";
import { GeminiHttpError, getModel } from "../lib/gemini";
import { getDataDir } from "../lib/attachments";
import { loadEnvLocal } from "./env";
import type { CheckOutcome, Classification, EmailRecord, EmailResult, SubmissionEntry } from "../lib/types";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => args[args.indexOf(`--${n}`) + 1];
const ROOT = process.cwd();
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const CLASSIFY_BATCH = 8;
// Resolved lazily, after loadEnvLocal() runs in main() - see lib/attachments.ts.
let CACHE = "";
let DATA_DIR = "";

async function pMap<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** A bad key / unknown model would fail every email identically - stop instead of writing a report full of errors. */
function failFast(err: unknown) {
  if (err instanceof GeminiHttpError && err.fatal) {
    console.error(`\nStopped: Gemini returned ${err.status}: ${err.message}\nRun  npm run check-key  to diagnose the key and model.`);
    process.exit(1);
  }
}

async function readCache<T>(name: string): Promise<T | null> {
  if (flag("fresh")) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE, name), "utf8")) as T;
  } catch {
    return null;
  }
}
const writeCache = (name: string, v: unknown) => fs.writeFile(path.join(CACHE, name), JSON.stringify(v));

async function main() {
  loadEnvLocal();
  DATA_DIR = getDataDir();
  // Cache is namespaced by dataset (the DATA_DIR folder name) so switching between the
  // toy data/ and the real data_v2/ never reuses a cached result for the wrong document set.
  CACHE = path.join(ROOT, ".cache", path.basename(DATA_DIR));
  await fs.mkdir(CACHE, { recursive: true });
  console.log(`dataset: ${DATA_DIR}`);
  const inboxDir = path.join(DATA_DIR, "inbox");
  let emails: EmailRecord[] = await Promise.all(
    (await fs.readdir(inboxDir)).filter((f) => f.endsWith(".json")).sort().map(async (f) => JSON.parse(await fs.readFile(path.join(inboxDir, f), "utf8"))),
  );
  const all = emails;
  if (opt("only")) {
    const ids = new Set(opt("only").split(","));
    emails = emails.filter((e) => ids.has(e.email_id));
  }
  console.log(`${emails.length} emails, model ${getModel()}, concurrency ${CONCURRENCY}`);

  /* ---- stage 1: classify (8 emails per model call) ---- */
  const cls: Record<string, Classification | { error: string }> = {};
  const todo: EmailRecord[] = [];
  for (const e of emails) {
    const c = await readCache<Classification>(`cls_${e.email_id}.json`);
    if (c) cls[e.email_id] = c;
    else todo.push(e);
  }
  const chunks: EmailRecord[][] = [];
  for (let i = 0; i < todo.length; i += CLASSIFY_BATCH) chunks.push(todo.slice(i, i + CLASSIFY_BATCH));
  let done = 0;
  await pMap(chunks, CONCURRENCY, async (chunk) => {
    try {
      const res = await classifyEmails(chunk);
      for (const e of chunk) {
        cls[e.email_id] = res[e.email_id];
        await writeCache(`cls_${e.email_id}.json`, res[e.email_id]);
      }
    } catch (err) {
      failFast(err);
      for (const e of chunk) cls[e.email_id] = { error: (err as Error).message };
    }
    done += chunk.length;
    process.stdout.write(`\rclassified ${done + (emails.length - todo.length)}/${emails.length}`);
  });
  console.log();

  /* ---- stage 2+3: extract + compare for document-check requests ---- */
  const toCheck = emails.filter((e) => {
    const c = cls[e.email_id];
    return c && !("error" in c) && c.category === "BL_COMPARISON";
  });
  const checks: Record<string, CheckOutcome | { error: string }> = {};
  done = 0;
  await pMap(toCheck, CONCURRENCY, async (e) => {
    const cached = await readCache<CheckOutcome>(`chk_${e.email_id}.json`);
    if (cached) checks[e.email_id] = cached;
    else {
      try {
        const c = cls[e.email_id];
        const out = await checkEmail(e, c && !("error" in c) ? c.expects_attachment : true);
        checks[e.email_id] = out;
        await writeCache(`chk_${e.email_id}.json`, out);
      } catch (err) {
        failFast(err);
        checks[e.email_id] = { error: (err as Error).message };
      }
    }
    process.stdout.write(`\rchecked ${++done}/${toCheck.length}`);
  });
  console.log();

  /* ---- assemble report ---- */
  const results: EmailResult[] = emails.map((e) => {
    const c = cls[e.email_id];
    const base = {
      email_id: e.email_id,
      from: e.from,
      subject: e.subject,
      body_preview: cleanBody(e.body, 400),
      attachments: e.attachments,
    };
    if (!c || "error" in c) {
      return { ...base, category: "GENERAL", category_confidence: 0, category_reason: "classification failed", status: "OK", review_reason: null, has_defect: false, defect_fields: [], processing_error: `classification: ${c?.error ?? "no result"}` } as EmailResult;
    }
    const r: EmailResult = { ...base, category: c.category, category_confidence: c.confidence, category_reason: c.reason, status: "OK", review_reason: null, has_defect: false, defect_fields: [] };
    if (c.category === "BL_COMPARISON") {
      const k = checks[e.email_id];
      if (!k || "error" in k) r.processing_error = `check: ${k?.error ?? "no result"}`;
      else Object.assign(r, k);
    }
    return r;
  });

  // merge with any previous report when running a subset
  const reportPath = path.join(DATA_DIR, "report.json");
  let merged = results;
  if (opt("only")) {
    try {
      const prev: { results: EmailResult[] } = JSON.parse(await fs.readFile(reportPath, "utf8"));
      const byId = new Map(prev.results.map((r) => [r.email_id, r]));
      results.forEach((r) => byId.set(r.email_id, r));
      merged = all.map((e) => byId.get(e.email_id)).filter(Boolean) as EmailResult[];
    } catch {}
  }
  await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), model: getModel(), results: merged }));

  const submission: Record<string, SubmissionEntry> = {};
  for (const r of merged) {
    submission[r.email_id] = { category: r.category, status: r.status, review_reason: r.review_reason, has_defect: r.has_defect, defect_fields: r.defect_fields };
  }
  await fs.writeFile(path.join(ROOT, "submission.json"), JSON.stringify(submission, null, 2));
  console.log(`\nScore it (needs the eval server running separately):  npm run score`);

  const tally = (f: (r: EmailResult) => string) => merged.reduce<Record<string, number>>((a, r) => ((a[f(r)] = (a[f(r)] ?? 0) + 1), a), {});
  console.log("categories:", tally((r) => r.category));
  console.log("document checks:", tally((r) => (r.category === "BL_COMPARISON" ? r.status + (r.review_reason ? `:${r.review_reason}` : "") : "-")));
  const errors = merged.filter((r) => r.processing_error);
  if (errors.length) {
    console.log(`\n${errors.length} emails failed - run npm run batch again to retry only these (they stay visible in the dashboard):`);
    errors.slice(0, 10).forEach((r) => console.log(" ", r.email_id, r.processing_error));
  }
  console.log("\nwrote data/report.json and submission.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
