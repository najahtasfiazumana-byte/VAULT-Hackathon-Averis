export type Category = "BL_COMPARISON" | "SI_REQUEST" | "INVOICE_QUERY" | "GENERAL" | "SPAM";
export const CATEGORIES: Category[] = ["BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY", "GENERAL", "SPAM"];

export const FIELDS = [
  "shipper",
  "consignee",
  "notify_party",
  "port_of_loading",
  "port_of_discharge",
  "container_count",
  "gross_weight_kg",
] as const;
export type FieldName = (typeof FIELDS)[number];

export const FIELD_LABELS: Record<FieldName, string> = {
  shipper: "Shipper",
  consignee: "Consignee",
  notify_party: "Notify party",
  port_of_loading: "Port of loading",
  port_of_discharge: "Port of discharge",
  container_count: "Container count",
  gross_weight_kg: "Gross weight (kg)",
};

export type Status = "OK" | "MISMATCH" | "NEEDS_REVIEW";
export type ReviewReason = "wrong_doc_type" | "missing_attachment" | "unreadable" | "missing_value";

export type FieldValue = string | number | null;

export interface EmailRecord {
  email_id: string;
  from: string;
  subject: string;
  body: string;
  attachments: string[];
}

export interface Classification {
  category: Category;
  confidence: number;
  reason: string;
  /**
   * Only meaningful for BL_COMPARISON with zero attachments: true if the email implies the
   * SI/BL should already be attached (so a missing attachment is a real problem to escalate);
   * false if it's a forward-looking request ("please send/prepare the draft BL for checking")
   * where nothing is attached because nothing exists yet - that's fine, just classify it.
   * Defaults to true (the safer, escalate-when-unsure default) when the model omits it.
   */
  expects_attachment: boolean;
}

export interface ExtractedField {
  value: FieldValue;
  evidence: string | null;
}

export interface Extraction {
  doc_type: "SI" | "BL" | "OTHER";
  readable: boolean;
  unreadable_reason: string | null;
  fields: Record<FieldName, ExtractedField>;
  container_weights_kg: number[];
}

export interface FieldComparison {
  field: FieldName;
  si: FieldValue;
  bl: FieldValue;
  /** true = match, false = discrepancy, null = cannot compare (a value is missing) */
  match: boolean | null;
  si_evidence: string | null;
  bl_evidence: string | null;
}

export interface CheckOutcome {
  status: Status;
  review_reason: ReviewReason | null;
  review_detail: string | null;
  has_defect: boolean;
  defect_fields: FieldName[];
  comparisons: FieldComparison[];
  si: Extraction | null;
  bl: Extraction | null;
  /** Plain-English note from Gemini, only set for MISMATCH. Optional: comparisons/defect_fields remain the source of truth. */
  explanation: string | null;
}

export interface EmailResult extends Partial<CheckOutcome> {
  email_id: string;
  from: string;
  subject: string;
  body_preview: string;
  category: Category;
  category_confidence: number;
  category_reason: string;
  status: Status;
  review_reason: ReviewReason | null;
  has_defect: boolean;
  defect_fields: FieldName[];
  attachments: string[];
  processing_error?: string | null;
}

export interface SubmissionEntry {
  category: Category;
  status: Status;
  review_reason: ReviewReason | null;
  has_defect: boolean;
  defect_fields: FieldName[];
}
