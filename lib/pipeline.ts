import { generateJson, ValidationError, type Part } from "./gemini";
import { CLASSIFY_SYSTEM, EXPLAIN_SYSTEM, EXTRACT_SYSTEM } from "./prompts";
import { loadAttachment, type LoadedDoc } from "./attachments";
import { decide, missingAttachment } from "./compare";
import { cleanBody, isBlank, toNumber } from "./normalize";
import { classifyByRules } from "./rules";
import {
  CATEGORIES,
  FIELDS,
  type CheckOutcome,
  type Classification,
  type EmailRecord,
  type ExtractedField,
  type Extraction,
  type FieldComparison,
  type FieldName,
} from "./types";

/* ------------------------------ Stage 1: classify ------------------------------ */

// Re-exported for callers that import cleanBody from here (e.g. scripts/run-batch.ts).
export { cleanBody };

function validateClassification(raw: unknown): Record<string, Classification> {
  const results = (raw as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) throw new Error("classification: 'results' missing");
  const out: Record<string, Classification> = {};
  for (const r of results as Record<string, unknown>[]) {
    const id = String(r.email_id ?? "");
    const category = String(r.category ?? "");
    if (!id || !CATEGORIES.includes(category as never)) continue;
    out[id] = {
      category: category as Classification["category"],
      confidence: Math.min(1, Math.max(0, Number(r.confidence ?? 0.5))),
      reason: String(r.reason ?? "").slice(0, 160),
      // Default true (escalate) when the model omits it - the safer default when unsure.
      expects_attachment: r.expects_attachment !== false,
    };
  }
  return out;
}

async function classifyOnce(emails: EmailRecord[]): Promise<Record<string, Classification>> {
  const payload = emails.map((e) => ({
    email_id: e.email_id,
    subject: e.subject,
    body: cleanBody(e.body),
    attachment_files: e.attachments.map((a) => a.split("/").pop()),
  }));
  return generateJson([{ text: JSON.stringify(payload) }], CLASSIFY_SYSTEM, validateClassification);
}

/**
 * Classifies a batch of emails. Each one first goes through classifyByRules() - a free,
 * deterministic keyword pass over the subject/body (lib/rules.ts). Only the emails rules can't
 * confidently decide (which always includes every BL_COMPARISON case, and any scan/attachment
 * question, since rules never look at attachments) go to Gemini: a small batch in one call, with
 * anything the model skipped retried on its own.
 */
export async function classifyEmails(emails: EmailRecord[]): Promise<Record<string, Classification>> {
  const out: Record<string, Classification> = {};
  const needsAi: EmailRecord[] = [];
  for (const e of emails) {
    const ruled = classifyByRules(e);
    if (ruled) out[e.email_id] = ruled;
    else needsAi.push(e);
  }
  if (needsAi.length === 0) return out;

  const ai =
    needsAi.length > 1 ? await classifyOnce(needsAi).catch(() => ({}) as Record<string, Classification>) : {};
  Object.assign(out, ai);
  const missing = needsAi.filter((e) => !out[e.email_id]);
  for (const e of missing) {
    const one = await classifyOnce([e]);
    if (!one[e.email_id]) throw new Error(`no classification returned for ${e.email_id}`);
    out[e.email_id] = one[e.email_id];
  }
  return out;
}

/* ------------------------------ Stage 2: extract ------------------------------ */

function num(v: unknown): number | null {
  return toNumber(v);
}

function validateExtraction(raw: unknown): Extraction {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object" || typeof r.fields !== "object" || r.fields === null) {
    throw new Error("extraction: 'fields' missing");
  }
  const src = r.fields as Record<string, { value?: unknown; evidence?: unknown } | undefined>;
  const fields = {} as Record<FieldName, ExtractedField>;
  for (const f of FIELDS) {
    const item = src[f] ?? {};
    let value: string | number | null;
    if (f === "container_count" || f === "gross_weight_kg") value = num(item.value);
    else value = isBlank(item.value as string | null) ? null : String(item.value).trim();
    fields[f] = { value, evidence: item.evidence ? String(item.evidence).slice(0, 200) : null };
  }
  const type = String(r.doc_type ?? "OTHER").toUpperCase();
  return {
    doc_type: type === "SI" || type === "BL" ? type : "OTHER",
    readable: r.readable !== false,
    unreadable_reason: r.unreadable_reason ? String(r.unreadable_reason) : null,
    fields,
    container_weights_kg: Array.isArray(r.container_weights_kg)
      ? (r.container_weights_kg.map(num).filter((n) => n !== null) as number[])
      : [],
  };
}

export async function extractDocument(doc: Exclude<LoadedDoc, { kind: "error" }>, expected: "SI" | "BL"): Promise<Extraction> {
  const intro = `The sender attached this as the ${expected === "SI" ? "Shipping Instruction (SI)" : "draft Bill of Lading (BL)"}. Extract the fields.`;
  const parts: Part[] =
    doc.kind === "text"
      ? [{ text: `${intro}\n\nDocument (${doc.format}):\n${doc.text}` }]
      : [{ text: intro }, { inlineData: { mimeType: doc.mimeType, data: doc.base64 } }];
  return generateJson(parts, EXTRACT_SYSTEM, validateExtraction);
}

function validateExplanation(raw: unknown): string {
  const text = String((raw as { explanation?: unknown })?.explanation ?? "").trim();
  if (!text) throw new ValidationError("empty explanation");
  return text.slice(0, 500);
}

/** Plain-English note on a confirmed mismatch, for the reviewer. Optional: the table of defect fields is the source of truth. */
export async function explainMismatch(comparisons: FieldComparison[]): Promise<string> {
  const defects = comparisons.filter((c) => c.match === false).map((c) => ({ field: c.field, si: c.si, bl: c.bl }));
  return generateJson([{ text: JSON.stringify(defects) }], EXPLAIN_SYSTEM, validateExplanation, 3);
}

/* ------------------------------ Stage 3: check ------------------------------ */

function unreadableStub(type: "SI" | "BL", reason: string): Extraction {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, { value: null, evidence: null }])) as Record<FieldName, ExtractedField>;
  return { doc_type: type, readable: false, unreadable_reason: reason, fields, container_weights_kg: [] };
}

/** Compare two already-loaded documents. `null` means the document is missing. */
export async function checkDocuments(si: LoadedDoc | null, bl: LoadedDoc | null): Promise<CheckOutcome> {
  if (!si || !bl) {
    const gone = [!si && "Shipping Instruction", !bl && "draft BL"].filter(Boolean).join(" and ");
    return missingAttachment(`No ${gone} attached to the email.`);
  }
  const [siEx, blEx] = await Promise.all([
    si.kind === "error" ? unreadableStub("SI", si.reason) : extractDocument(si, "SI"),
    bl.kind === "error" ? unreadableStub("BL", bl.reason) : extractDocument(bl, "BL"),
  ]);
  const outcome = decide(siEx, blEx);
  if (outcome.status === "MISMATCH") {
    // Best-effort: a failed explanation should never turn a real mismatch into a processing error.
    outcome.explanation = await explainMismatch(outcome.comparisons).catch(() => null);
  }
  return outcome;
}

/** No document to check, and none expected: the OK outcome, with no comparisons to show. */
function nothingToCompare(): CheckOutcome {
  return {
    status: "OK",
    review_reason: null,
    review_detail: null,
    has_defect: false,
    defect_fields: [],
    comparisons: [],
    si: null,
    bl: null,
    explanation: null,
  };
}

/**
 * `expectsAttachment` (from classification) distinguishes a genuine reliability problem from a
 * normal "please send the draft BL for checking" request: both have zero attachments, but only
 * the former should be escalated to a human. Default true (escalate) when unknown/unset.
 */
export async function checkEmail(email: EmailRecord, expectsAttachment = true): Promise<CheckOutcome> {
  const pick = (kind: "SI" | "BL") => email.attachments.find((a) => new RegExp(`_${kind}\\.[a-z0-9]+$`, "i").test(a));
  const siPath = pick("SI");
  const blPath = pick("BL");
  if (!siPath && !blPath && !expectsAttachment) return nothingToCompare();
  return checkDocuments(siPath ? await loadAttachment(siPath) : null, blPath ? await loadAttachment(blPath) : null);
}

/* ------------------------------ Whole email, live ------------------------------ */

import type { EmailResult } from "./types";

/** Full pipeline for a single email (used by the live "re-run" route). */
export async function processEmail(email: EmailRecord): Promise<EmailResult> {
  const base = {
    email_id: email.email_id,
    from: email.from,
    subject: email.subject,
    body_preview: cleanBody(email.body, 400),
    attachments: email.attachments,
  };
  try {
    const cls = (await classifyEmails([email]))[email.email_id];
    const result: EmailResult = {
      ...base,
      category: cls.category,
      category_confidence: cls.confidence,
      category_reason: cls.reason,
      status: "OK",
      review_reason: null,
      has_defect: false,
      defect_fields: [],
    };
    if (cls.category === "BL_COMPARISON") Object.assign(result, await checkEmail(email, cls.expects_attachment));
    return result;
  } catch (e) {
    return {
      ...base,
      category: "GENERAL",
      category_confidence: 0,
      category_reason: "processing failed",
      status: "OK",
      review_reason: null,
      has_defect: false,
      defect_fields: [],
      processing_error: (e as Error).message,
    };
  }
}
