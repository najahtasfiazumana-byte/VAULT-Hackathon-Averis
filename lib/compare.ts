import {
  FIELDS,
  type CheckOutcome,
  type Extraction,
  type ExtractedField,
  type FieldComparison,
  type FieldName,
  type ReviewReason,
} from "./types";
import { isBlank, toNumber, valuesMatch } from "./normalize";

export function emptyExtraction(type: "SI" | "BL"): Extraction {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, { value: null, evidence: null }])) as Record<
    FieldName,
    ExtractedField
  >;
  return { doc_type: type, readable: true, unreadable_reason: null, fields, container_weights_kg: [] };
}

/** "SAME AS CONSIGNEE" style notify parties resolve to the consignee on the same document. */
function resolvedNotify(doc: Extraction) {
  const n = doc.fields.notify_party;
  if (typeof n.value === "string" && /^\s*(same as\s+)?(the\s+)?consignee\s*\.?\s*$/i.test(n.value)) {
    return { value: doc.fields.consignee.value, evidence: n.evidence };
  }
  return n;
}

/** If the declared totals are missing but a container table exists, derive them. */
function withDerivedTotals(doc: Extraction): Extraction {
  const rows = doc.container_weights_kg.filter((w) => toNumber(w) !== null);
  const fields = { ...doc.fields };
  if (isBlank(fields.gross_weight_kg.value) && rows.length) {
    const sum = rows.reduce((a, b) => a + Number(b), 0);
    fields.gross_weight_kg = { value: sum, evidence: `sum of ${rows.length} container weights` };
  }
  if (isBlank(fields.container_count.value) && rows.length) {
    fields.container_count = { value: rows.length, evidence: `${rows.length} container rows` };
  }
  fields.notify_party = resolvedNotify({ ...doc, fields });
  return { ...doc, fields };
}

export function compareExtractions(siRaw: Extraction, blRaw: Extraction): FieldComparison[] {
  const si = withDerivedTotals(siRaw);
  const bl = withDerivedTotals(blRaw);
  return FIELDS.map((field) => {
    const a = si.fields[field];
    const b = bl.fields[field];
    const missing = isBlank(a.value) || isBlank(b.value);
    return {
      field,
      si: a.value,
      bl: b.value,
      match: missing ? null : valuesMatch(field, a.value, b.value),
      si_evidence: a.evidence,
      bl_evidence: b.evidence,
    };
  });
}

/**
 * Turns two extractions into a final decision.
 * Order: unreadable / wrong doc type -> confirmed mismatch -> missing value -> OK.
 * (A confirmed discrepancy is reported even if some other field could not be read.)
 */
export function decide(si: Extraction, bl: Extraction): CheckOutcome {
  const base = { si, bl, comparisons: [] as FieldComparison[] };
  const review = (reason: ReviewReason, detail: string): CheckOutcome => ({
    ...base,
    comparisons: si.readable && bl.readable ? compareExtractions(si, bl) : [],
    status: "NEEDS_REVIEW",
    review_reason: reason,
    review_detail: detail,
    has_defect: false,
    defect_fields: [],
    explanation: null,
  });

  if (!si.readable || !bl.readable) {
    const which = [!si.readable && "SI", !bl.readable && "BL"].filter(Boolean).join(" and ");
    const why = si.unreadable_reason ?? bl.unreadable_reason ?? "content could not be read";
    return review("unreadable", `${which} could not be read: ${why}`);
  }
  if (si.doc_type !== "SI" || bl.doc_type !== "BL") {
    return review(
      "wrong_doc_type",
      `Expected an SI and a BL but the attachments look like ${si.doc_type} and ${bl.doc_type}.`,
    );
  }

  const comparisons = compareExtractions(si, bl);
  const defect_fields = comparisons.filter((c) => c.match === false).map((c) => c.field);
  if (defect_fields.length) {
    return { ...base, comparisons, status: "MISMATCH", review_reason: null, review_detail: null, has_defect: true, defect_fields, explanation: null };
  }
  const missing = comparisons.filter((c) => c.match === null).map((c) => c.field);
  if (missing.length) {
    return {
      ...base,
      comparisons,
      status: "NEEDS_REVIEW",
      review_reason: "missing_value",
      review_detail: `No value found for: ${missing.join(", ")}`,
      has_defect: false,
      defect_fields: [],
      explanation: null,
    };
  }
  return { ...base, comparisons, status: "OK", review_reason: null, review_detail: null, has_defect: false, defect_fields: [], explanation: null };
}

export function missingAttachment(detail: string): CheckOutcome {
  return {
    status: "NEEDS_REVIEW",
    review_reason: "missing_attachment",
    review_detail: detail,
    has_defect: false,
    defect_fields: [],
    comparisons: [],
    si: null,
    bl: null,
    explanation: null,
  };
}
