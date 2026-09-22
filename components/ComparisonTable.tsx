import { FIELD_LABELS, type FieldComparison } from "@/lib/types";

export default function ComparisonTable({ rows }: { rows: FieldComparison[] }) {
  if (!rows.length) return <p className="muted">No field comparison available.</p>;
  return (
    <table className="cmp">
      <thead>
        <tr>
          <th>Field</th>
          <th>Shipping Instruction</th>
          <th>Draft BL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.field} className={r.match === false ? "bad" : r.match === null ? "unk" : ""}>
            <td>{FIELD_LABELS[r.field]}</td>
            <td title={r.si_evidence ?? ""}>{r.si ?? <em>missing</em>}</td>
            <td title={r.bl_evidence ?? ""}>{r.bl ?? <em>missing</em>}</td>
            <td className="mark">{r.match === true ? "✓" : r.match === false ? "✗ mismatch" : "? review"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
