import type { FieldName, FieldValue } from "./types";

/** Strips the "forwarded from outside" banner and clamps length before an email goes to a model (or a rule). */
export function cleanBody(body: string, max = 900): string {
  return body
    .replace(/WARNING: This email originated[\s\S]*?(?:\n\s*\n|$)/i, "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, max);
}

const SUFFIXES: Record<string, string> = {
  LIMITED: "LTD",
  COMPANY: "CO",
  CORPORATION: "CORP",
  INCORPORATED: "INC",
  BERHAD: "BHD",
};

/** Company names: ignore case, punctuation, spacing and legal-suffix spelling (LTD vs LIMITED). */
export function normName(v: string): string {
  let s = v.toUpperCase().replace(/&/g, " AND ");
  s = s.replace(/\((NON[- ]?NEGOTIABLE|NEGOTIABLE)\)/g, " ");
  s = s.replace(/[^A-Z0-9 ]+/g, " ");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIXES[w] ?? w)
    .join(" ");
}

export interface ParsedPort {
  name: string;
  code: string | null;
}

/** Ports: keep the place name (before the country) and a UN/LOCODE like (CNNTG) if present. */
export function parsePort(v: string): ParsedPort {
  const upper = v.toUpperCase();
  const code = upper.match(/\(([A-Z]{2}[A-Z0-9]{3})\)/)?.[1] ?? null;
  let name = upper.replace(/\([^)]*\)/g, " ");
  name = name.split(",")[0];
  name = name
    .replace(/\bPORT OF\b/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name, code };
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    if (v.trim() !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

export function isBlank(v: FieldValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** true = same, false = different. Both values must be non-blank. */
export function valuesMatch(field: FieldName, a: FieldValue, b: FieldValue): boolean {
  switch (field) {
    case "shipper":
    case "consignee":
    case "notify_party":
      return normName(String(a)) === normName(String(b));
    case "port_of_loading":
    case "port_of_discharge": {
      const pa = parsePort(String(a));
      const pb = parsePort(String(b));
      if (pa.name === pb.name) return true;
      return !!pa.code && pa.code === pb.code;
    }
    case "container_count": {
      const x = toNumber(a);
      const y = toNumber(b);
      return x !== null && y !== null && Math.round(x) === Math.round(y);
    }
    case "gross_weight_kg": {
      const x = toNumber(a);
      const y = toNumber(b);
      return x !== null && y !== null && Math.abs(x - y) < 0.5;
    }
  }
}
