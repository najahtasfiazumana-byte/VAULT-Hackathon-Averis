"use client";
import { useState } from "react";
import { FIELDS, FIELD_LABELS, type FieldName, type FieldValue } from "@/lib/types";
import type { DocValues, EffectiveResult, Override } from "@/lib/overrides";

function initial(r: EffectiveResult, side: "si" | "bl"): Record<FieldName, string> {
  const doc = r[side];
  return Object.fromEntries(FIELDS.map((f) => [f, doc?.fields[f]?.value == null ? "" : String(doc.fields[f].value)])) as Record<FieldName, string>;
}

function toValues(form: Record<FieldName, string>): DocValues {
  const out: DocValues = {};
  for (const f of FIELDS) {
    const t = form[f].trim();
    let v: FieldValue = t === "" ? null : t;
    if (v !== null && (f === "container_count" || f === "gross_weight_kg")) {
      const n = Number(t.replace(/,/g, ""));
      v = Number.isFinite(n) ? n : null;
    }
    out[f] = v;
  }
  return out;
}

export default function ReviewForm({
  result,
  onSave,
  onClear,
}: {
  result: EffectiveResult;
  onSave: (o: Override) => void;
  onClear: () => void;
}) {
  const [si, setSi] = useState(() => initial(result, "si"));
  const [bl, setBl] = useState(() => initial(result, "bl"));
  const [note, setNote] = useState(result.review_note ?? "");

  return (
    <div className="review">
      <h4>Human review - confirm or correct the values</h4>
      <p className="muted">
        Read the source documents above, fill in or correct any value, then recompute. The report updates immediately.
      </p>
      <table className="cmp">
        <thead>
          <tr>
            <th>Field</th>
            <th>SI value</th>
            <th>BL value</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((f) => (
            <tr key={f}>
              <td>{FIELD_LABELS[f]}</td>
              <td>
                <input value={si[f]} onChange={(e) => setSi({ ...si, [f]: e.target.value })} />
              </td>
              <td>
                <input value={bl[f]} onChange={(e) => setBl({ ...bl, [f]: e.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <input className="note" placeholder="Reviewer note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button className="primary" onClick={() => onSave({ si: toValues(si), bl: toValues(bl), note, at: new Date().toISOString() })}>
          Save review &amp; recompute
        </button>
        {result.reviewed && <button onClick={onClear}>Undo review</button>}
      </div>
    </div>
  );
}
