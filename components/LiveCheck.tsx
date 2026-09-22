"use client";
import { useState } from "react";
import ComparisonTable from "./ComparisonTable";
import StatusBadge from "./StatusBadge";
import type { CheckOutcome } from "@/lib/types";

const SAMPLES = [
  { id: "email_512", label: "Scanned PDFs (image-only)" },
  { id: "email_059", label: "Text PDFs with container tables" },
  { id: "email_055", label: "Word BL + Excel SI" },
  { id: "email_004", label: "Plain text (has a real defect)" },
];

export default function LiveCheck() {
  const [si, setSi] = useState<File | null>(null);
  const [bl, setBl] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<CheckOutcome | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(siFile: File | null, blFile: File | null) {
    setBusy(true);
    setErr(null);
    setOut(null);
    try {
      const fd = new FormData();
      if (siFile) fd.append("si", siFile);
      if (blFile) fd.append("bl", blFile);
      const res = await fetch("/api/check", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "request failed");
      setOut(json);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sample(id: string) {
    setBusy(true);
    setErr(null);
    try {
      // attachments follow the <id>_SI.<ext> / <id>_BL.<ext> naming convention
      const get = async (kind: "SI" | "BL") => {
        for (const ext of ["pdf", "docx", "xlsx", "txt"]) {
          const r = await fetch(`/api/attachment?path=${encodeURIComponent(`attachments/${id}_${kind}.${ext}`)}`);
          if (r.ok) return new File([await r.blob()], `${id}_${kind}.${ext}`);
        }
        return null;
      };
      const [a, b] = await Promise.all([get("SI"), get("BL")]);
      setSi(a);
      setBl(b);
      await run(a, b);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Live check</h3>
      <p className="muted">Upload a Shipping Instruction and a draft BL (text, Word, Excel, PDF or scanned image) and get the discrepancy report.</p>
      <div className="row">
        <label className="file">
          SI file
          <input type="file" onChange={(e) => setSi(e.target.files?.[0] ?? null)} />
          <span>{si?.name ?? "none"}</span>
        </label>
        <label className="file">
          Draft BL file
          <input type="file" onChange={(e) => setBl(e.target.files?.[0] ?? null)} />
          <span>{bl?.name ?? "none"}</span>
        </label>
        <button className="primary" disabled={busy} onClick={() => run(si, bl)}>
          {busy ? "Reading documents…" : "Compare"}
        </button>
      </div>
      <div className="row wrap">
        <span className="muted">Or try a sample:</span>
        {SAMPLES.map((s) => (
          <button key={s.id} disabled={busy} onClick={() => sample(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
      {out && (
        <div className="result">
          <div className="row">
            <StatusBadge status={out.status} />
          </div>
          {out.status === "MISMATCH" && (
            <p className="callout bad">{out.explanation ?? `Fix before finalising: ${out.defect_fields.join(", ")}`}</p>
          )}
          {out.review_detail && <p className="warn">Needs review ({out.review_reason}): {out.review_detail}</p>}
          <ComparisonTable rows={out.comparisons} />
        </div>
      )}
    </div>
  );
}
