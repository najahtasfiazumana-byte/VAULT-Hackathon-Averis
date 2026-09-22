import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decide, emptyExtraction } from "../lib/compare";
import { checkEmail } from "../lib/pipeline";
import type { EmailRecord, Extraction, FieldName } from "../lib/types";

function doc(type: "SI" | "BL", v: Partial<Record<FieldName, string | number | null>>): Extraction {
  const d = emptyExtraction(type);
  for (const [k, val] of Object.entries(v)) d.fields[k as FieldName] = { value: val as never, evidence: null };
  return d;
}
const base = {
  shipper: "APRIL FAR EAST (M) SDN BHD",
  consignee: "EAST BRIGHT FZ-LLC",
  notify_party: "EAST BRIGHT FZ-LLC",
  port_of_loading: "NANTONG, CHINA (CNNTG)",
  port_of_discharge: "KARACHI, PAKISTAN (PKKHI)",
  container_count: 3,
  gross_weight_kg: 22000,
};

test("identical documents are OK", () => {
  assert.equal(decide(doc("SI", base), doc("BL", base)).status, "OK");
});

test("label/format differences are not defects", () => {
  const bl = { ...base, shipper: "April Far East (M) Sdn. Bhd.", port_of_loading: "NANTONG", port_of_discharge: "Port of Karachi, Pakistan", gross_weight_kg: "22,000" as never, notify_party: "same as consignee" };
  assert.equal(decide(doc("SI", base), doc("BL", bl)).status, "OK");
});

test("spec example: only container count is flagged", () => {
  const out = decide(doc("SI", base), doc("BL", { ...base, container_count: 4 }));
  assert.equal(out.status, "MISMATCH");
  assert.deepEqual(out.defect_fields, ["container_count"]);
});

test("different consignee and notify are both flagged", () => {
  const out = decide(doc("SI", base), doc("BL", { ...base, consignee: "UAB NOVAKOPA", notify_party: "UAB NOVAKOPA" }));
  assert.deepEqual(out.defect_fields, ["consignee", "notify_party"]);
});

test("missing value goes to review, unreadable goes to review", () => {
  assert.equal(decide(doc("SI", base), doc("BL", { ...base, gross_weight_kg: null })).review_reason, "missing_value");
  const bad = doc("BL", base);
  bad.readable = false;
  assert.equal(decide(doc("SI", base), bad).review_reason, "unreadable");
  const wrong = doc("BL", base);
  wrong.doc_type = "OTHER";
  assert.equal(decide(doc("SI", base), wrong).review_reason, "wrong_doc_type");
});

test("derives totals from container rows", () => {
  const si = doc("SI", { ...base, container_count: null, gross_weight_kg: null });
  si.container_weights_kg = [10000, 12000, 0];
  assert.equal(decide(si, doc("BL", base)).status, "OK");
});

/* Cross-check the comparison rules on the real plain-text pairs using a throwaway regex reader. */
function parseTxt(text: string, type: "SI" | "BL"): Extraction {
  const line = (re: RegExp) => text.match(re)?.[1]?.trim() ?? null;
  const d = emptyExtraction(type);
  const set = (f: FieldName, v: string | number | null) => (d.fields[f] = { value: v, evidence: null });
  set("shipper", line(/^shipper[^:\n]*:\s*(.+)$/im));
  set("consignee", line(/^(?:consignee[^:\n]*|to the order of):\s*(.+)$/im));
  set("notify_party", line(/^notify[^:\n]*:\s*(.+)$/im));
  set("port_of_loading", line(/^(?:port of loading[^:\n]*|pol|load port):\s*(.+)$/im));
  set("port_of_discharge", line(/^(?:port of discharge[^:\n]*|pod|discharge port):\s*(.+)$/im));
  const c = line(/^(?:total containers|container count|no\. of containers[^:\n]*):\s*(\d+)/im);
  set("container_count", c ? Number(c) : null);
  const w = line(/^(?:gross wt[^:\n]*|gross weight[^:\n]*|total gross[^:\n]*):\s*([\d,\.]+)/im);
  set("gross_weight_kg", w ? Number(w.replace(/,/g, "")) : null);
  return d;
}

test("real txt pairs: report distribution (informational)", () => {
  const dir = path.join(process.cwd(), "data", "attachments");
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith("_SI.txt")).map((f) => f.replace("_SI.txt", ""));
  const tally: Record<string, number> = {};
  const byField: Record<string, number> = {};
  for (const id of ids) {
    const bl = path.join(dir, `${id}_BL.txt`);
    if (!fs.existsSync(bl)) continue;
    const out = decide(parseTxt(fs.readFileSync(path.join(dir, `${id}_SI.txt`), "utf8"), "SI"), parseTxt(fs.readFileSync(bl, "utf8"), "BL"));
    const key = out.status + (out.review_reason ? `:${out.review_reason}` : "");
    tally[key] = (tally[key] ?? 0) + 1;
    out.defect_fields.forEach((f) => (byField[f] = (byField[f] ?? 0) + 1));
  }
  console.log("txt pairs:", tally, "defects by field:", byField);
  assert.ok(Object.keys(tally).length > 0);
});

/* expects_attachment: distinguishes "please send the draft BL" (OK, just classify) from a
 * genuinely dropped attachment (NEEDS_REVIEW). Both cases resolve without a Gemini call, since
 * there is nothing to extract - safe to test directly. */
const noAttachEmail: EmailRecord = {
  email_id: "email_999",
  from: "docs@example.com",
  subject: "REQUEST BL DRAFT",
  body: "Please assist to send the draft BL for SIN832764835 for checking asap.",
  attachments: [],
};

test("forward-looking 'please send the draft BL' request: OK, not flagged for review", async () => {
  const out = await checkEmail(noAttachEmail, false);
  assert.equal(out.status, "OK");
  assert.equal(out.review_reason, null);
});

test("genuinely dropped/missing attachment: still escalated to review", async () => {
  const out = await checkEmail(noAttachEmail, true);
  assert.equal(out.status, "NEEDS_REVIEW");
  assert.equal(out.review_reason, "missing_attachment");
});
