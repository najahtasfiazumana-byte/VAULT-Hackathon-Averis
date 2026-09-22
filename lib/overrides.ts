import { decide, emptyExtraction } from "./compare";
import { FIELDS, type EmailResult, type Extraction, type FieldName, type FieldValue } from "./types";

export type DocValues = Partial<Record<FieldName, FieldValue>>;
export interface Override {
  si: DocValues;
  bl: DocValues;
  note?: string;
  at: string;
}

export type EffectiveResult = EmailResult & { reviewed?: boolean; review_note?: string };

function withValues(doc: Extraction | null | undefined, type: "SI" | "BL", values: DocValues): Extraction {
  const d: Extraction = JSON.parse(JSON.stringify(doc ?? emptyExtraction(type)));
  for (const f of FIELDS) {
    if (f in values) d.fields[f] = { value: values[f] ?? null, evidence: "entered by reviewer" };
  }
  // a person has looked at the source: it is readable and the types are what the reviewer says they are
  d.readable = true;
  d.unreadable_reason = null;
  d.doc_type = type;
  return d;
}

/** Re-runs the decision using the reviewer's confirmed/corrected values. */
export function applyOverride(r: EmailResult, o?: Override): EffectiveResult {
  if (!o || r.category !== "BL_COMPARISON") return r;
  const outcome = decide(withValues(r.si, "SI", o.si), withValues(r.bl, "BL", o.bl));
  return { ...r, ...outcome, reviewed: true, review_note: o.note };
}
