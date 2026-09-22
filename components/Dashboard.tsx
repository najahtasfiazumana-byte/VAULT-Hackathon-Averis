"use client";
import { useEffect, useMemo, useState } from "react";
import ComparisonTable from "./ComparisonTable";
import LiveCheck from "./LiveCheck";
import ReviewForm from "./ReviewForm";
import StatusBadge from "./StatusBadge";
import { applyOverride, type EffectiveResult, type Override } from "@/lib/overrides";
import type { EmailResult, FieldName, SubmissionEntry } from "@/lib/types";

type Report = { generatedAt: string; model: string; results: EmailResult[] } | null;
type Tab = "inbox" | "review" | "live";
const STORE = "sdoc-overrides-v1";

const CAT_LABEL: Record<string, string> = {
  BL_COMPARISON: "BL_COMPARISON",
  SI_REQUEST: "New SI request",
  INVOICE_QUERY: "Invoice query",
  GENERAL: "General",
  SPAM: "Spam",
};

export default function Dashboard({ report }: { report: Report }) {
  const [tab, setTab] = useState<Tab>("inbox");
  const [filter, setFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [live, setLive] = useState<Record<string, EmailResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      setOverrides(JSON.parse(localStorage.getItem(STORE) ?? "{}"));
    } catch {}
  }, []);
  const persist = (o: Record<string, Override>) => {
    setOverrides(o);
    try {
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch {}
  };

  const results: EffectiveResult[] = useMemo(
    () => (report?.results ?? []).map((r) => applyOverride(live[r.email_id] ?? r, overrides[r.email_id])),
    [report, live, overrides],
  );

  if (!report) {
    return (
      <main>
        <Header />
        <div className="card">
          <h3>No report yet</h3>
          <p>
            Run <code>npm run batch</code> locally (needs <code>GEMINI_API_KEY</code>) to process the inbox, commit
            <code> data/report.json</code>, and redeploy. The <strong>Live check</strong> tab works without it.
          </p>
        </div>
        <LiveCheck />
      </main>
    );
  }

  const checks = results.filter((r) => r.category === "BL_COMPARISON");
  const failed = results.filter((r) => r.processing_error);
  const needs = results.filter((r) => r.status === "NEEDS_REVIEW" && r.category === "BL_COMPARISON");
  const count = (s: string) => checks.filter((r) => r.status === s).length;

  const shown = results.filter((r) => {
    if (q && !`${r.subject} ${r.email_id} ${r.from}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === "ALL") return true;
    if (filter in CAT_LABEL) return r.category === filter;
    return r.category === "BL_COMPARISON" && r.status === filter;
  });
  const selected = results.find((r) => r.email_id === sel) ?? null;

  async function rerun(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/email/${id}`, { method: "POST" });
      const json = await res.json();
      if (res.ok) setLive((l) => ({ ...l, [id]: json }));
    } finally {
      setBusy(null);
    }
  }

  function exportSubmission() {
    const sub: Record<string, SubmissionEntry> = {};
    for (const r of results) {
      sub[r.email_id] = { category: r.category, status: r.status, review_reason: r.review_reason, has_defect: r.has_defect, defect_fields: r.defect_fields as FieldName[] };
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(sub, null, 2)], { type: "application/json" }));
    a.download = "submission.json";
    a.click();
  }

  return (
    <main>
      <Header />
      <section className="stats">
        <Stat n={results.length} label="Emails triaged" />
        <Stat n={checks.length} label="BL_COMPARISON" />
        <Stat n={count("MISMATCH")} label="Mismatches found" tone="bad" />
        <Stat n={count("OK")} label="No mismatch" tone="ok" />
        <Stat n={needs.length} label="Need human review" tone="warn" />
        <Stat n={failed.length} label="Processing failures" tone={failed.length ? "bad" : undefined} />
      </section>

      <nav className="tabs">
        {(
          [
            ["inbox", "Inbox report"],
            ["review", `Review queue (${needs.length + failed.length})`],
            ["live", "Live check"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        <span className="grow" />
        <button onClick={exportSubmission}>Export submission.json</button>
      </nav>

      {tab === "live" ? (
        <LiveCheck />
      ) : (
        <div className="split">
          <div className="list">
            {tab === "inbox" && (
              <div className="filters">
                <input placeholder="Search subject / id / sender" value={q} onChange={(e) => setQ(e.target.value)} />
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="ALL">All emails</option>
                  {Object.entries(CAT_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                  <option value="MISMATCH">Checks: mismatch</option>
                  <option value="OK">Checks: no mismatch</option>
                  <option value="NEEDS_REVIEW">Checks: needs review</option>
                </select>
              </div>
            )}
            <ul>
              {(tab === "review" ? [...failed, ...needs.filter((n) => !n.processing_error)] : shown).map((r) => (
                <li key={r.email_id} className={r.email_id === sel ? "sel" : ""} onClick={() => setSel(r.email_id)}>
                  <div className="row">
                    <span className="id">{r.email_id}</span>
                    <span className="cat">{CAT_LABEL[r.category]}</span>
                    {r.processing_error ? (
                      <span className="badge mismatch">Failed</span>
                    ) : r.category === "BL_COMPARISON" ? (
                      <StatusBadge status={r.status} label={r.reviewed ? `${r.status === "OK" ? "OK" : r.status === "MISMATCH" ? "Mismatch" : "Review"} (reviewed)` : undefined} />
                    ) : null}
                  </div>
                  <div className="subj">{r.subject || "(no subject)"}</div>
                  {r.status === "MISMATCH" && <div className="defects">{r.defect_fields.join(", ")}</div>}
                </li>
              ))}
            </ul>
          </div>

          <div className="detail">
            {!selected ? (
              <p className="muted">Select an email to see the classification, the side-by-side comparison and the source evidence.</p>
            ) : (
              <Detail
                key={selected.email_id + (selected.reviewed ? "r" : "")}
                r={selected}
                busy={busy === selected.email_id}
                onRerun={() => rerun(selected.email_id)}
                onSave={(o) => persist({ ...overrides, [selected.email_id]: o })}
                onClear={() => {
                  const { [selected.email_id]: _drop, ...rest } = overrides;
                  persist(rest);
                }}
              />
            )}
          </div>
        </div>
      )}
      <footer className="muted">
        Report generated {new Date(report.generatedAt).toLocaleString()} with {report.model}. Reviews are stored in this browser.
      </footer>
    </main>
  );
}

function Detail({ r, busy, onRerun, onSave, onClear }: { r: EffectiveResult; busy: boolean; onRerun: () => void; onSave: (o: Override) => void; onClear: () => void }) {
  const isCheck = r.category === "BL_COMPARISON";
  return (
    <div>
      <h3>{r.subject || "(no subject)"}</h3>
      <p className="muted">
        {r.email_id} · {r.from}
      </p>
      <div className="row wrap">
        <span className="cat">{CAT_LABEL[r.category]}</span>
        <span className="muted">
          AI confidence {(r.category_confidence * 100).toFixed(0)}% - {r.category_reason}
        </span>
      </div>
      <pre className="body">{r.body_preview}</pre>

      {r.processing_error && (
        <div className="callout bad">
          Processing failed: {r.processing_error}
          <div>
            <button className="primary" disabled={busy} onClick={onRerun}>
              {busy ? "Retrying…" : "Retry now"}
            </button>
          </div>
        </div>
      )}

      {isCheck && !r.processing_error && (
        <>
          <div className="row">
            <StatusBadge status={r.status} />
            {r.reviewed && <span className="badge ok">human-reviewed</span>}
          </div>
          {r.status === "MISMATCH" && r.explanation && <p className="callout bad">{r.explanation}</p>}
          {r.status === "MISMATCH" && !r.explanation && <strong>Fix before finalising: {r.defect_fields.join(", ")}</strong>}
          {r.status === "NEEDS_REVIEW" && (
            <div className="callout warn">
              Escalated to a person: <strong>{r.review_reason}</strong>. {r.review_detail}
            </div>
          )}
          <ComparisonTable rows={r.comparisons ?? []} />

          {r.attachments.length === 0 && <p className="muted">No attachments were found on this email.</p>}
          {r.attachments.length > 0 && (r.status === "NEEDS_REVIEW" || r.reviewed) && (
            <div className="sources">
              <h4>Source evidence</h4>
              {r.attachments.map((a) => (
                <div key={a}>
                  <a href={`/api/attachment?path=${encodeURIComponent(a)}`} target="_blank" rel="noreferrer">
                    {a.split("/").pop()}
                  </a>
                  {a.endsWith(".pdf") && <iframe src={`/api/attachment?path=${encodeURIComponent(a)}`} title={a} />}
                </div>
              ))}
            </div>
          )}
          {(r.status === "NEEDS_REVIEW" || r.reviewed) && <ReviewForm result={r} onSave={onSave} onClear={onClear} />}
          <div className="row">
            <button disabled={busy} onClick={onRerun}>
              {busy ? "Re-running…" : "Re-run with Gemini"}
            </button>
          </div>
        </>
      )}
      {!isCheck && !r.processing_error && <p className="muted">Classified only - this category does not continue to the checking step.</p>}
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1>SDOC Verifier</h1>
      <p className="muted">Inbox → classify → read SI &amp; BL (incl. scans) → compare 7 fields → discrepancy report, with a human in the loop.</p>
    </header>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  );
}
