import type { Category, Classification, EmailRecord } from "./types";
import { cleanBody } from "./normalize";

/**
 * Fast, deterministic first pass over an email's subject + body, tried before spending a Gemini
 * call. Returns a verdict only when the wording is unambiguous; everything else - including every
 * BL_COMPARISON case - returns null and falls through to classifyOnce() (the AI classifier) in
 * lib/pipeline.ts.
 *
 * The keyword lists below are not guesses: they're the literal recurring phrases found by
 * clustering the bodies of the bundled data_v2 inbox (520 emails) into their templates and
 * reading a sample of each. Matching is plain case-insensitive substring search - no hand-written
 * regex alternations - so every phrase here is auditable against what's actually in the data.
 * A handful of short tokens (eta, etd, thc, fyi, gr) use a trivial \b-wrapped literal match instead
 * of a bare substring check, only because a bare substring risks false hits inside unrelated words
 * (e.g. "eta" inside "metadata"); this is a safety wrapper, not a hand-crafted pattern.
 *
 * BL_COMPARISON is deliberately never decided by rules: telling a genuine "please check the SI
 * against the BL" request apart from an SI_REQUEST needs the same reading-comprehension the
 * classify prompt itself calls out ("subjects are often reused thread titles or misleading" -
 * confirmed by the data: several spam and GENERAL templates here reuse SI/BL-ish subject lines),
 * and expects_attachment (whether a missing attachment is a real problem worth escalating) needs
 * judgement a keyword match can't safely make. This function also never looks at attachments -
 * only subject/body text - so a scanned or otherwise illegible document is completely unaffected
 * by this stage: it's always read by Gemini vision in extractDocument, regardless of how (or
 * whether) rules classified the email that carried it.
 */

/** Any of these means the email is about checking/comparing a draft BL - always deferred to AI. */
const BL_COMPARISON_PHRASES = [
  "draft bl",
  "draft bill of lading",
  "check the si",
  "check the bl",
  "check the draft",
  "check the details",
  "compare the si",
  "compare the bl",
  "verify the si",
  "verify the bl",
  "match the si",
  "matches the si",
  "confirm the bl",
  "confirm the draft",
  "kindly check",
  "kindly verify",
  "kindly confirm",
  "attached are the si and",
  "si and draft bl",
  "si and the draft bl",
  "bl and the si",
  "bl draft",
  "amend bl",
  "bl amendment",
  "for checking asap",
  "bl file will not open",
  "scanned copies (image only)",
];

/**
 * One fixed line that ends every "Please find Shipping instruction for X" template in the data:
 * a forward-looking mention ("the draft BL doesn't exist yet") in an otherwise plain SI_REQUEST,
 * not a request to check anything. Stripped before the BL_COMPARISON gate runs so it can't shadow
 * a real SI_REQUEST rule match; every other "draft bl" mention in the data is a genuine
 * document-check case and is left untouched.
 */
const FORWARD_LOOKING_SI_TAIL = "please revert with draft bl once available";

const SPAM_PHRASES = [
  "congratulations!!! your email address has been selected",
  "you have been selected",
  "you've been selected",
  "claim your prize",
  "claim your reward",
  "lottery",
  "jackpot",
  "inheritance",
  "unclaimed funds",
  "next of kin",
  "dear beneficiary",
  "nigerian prince",
  "risk-free",
  "risk free",
  "100% free",
  "no cost to you",
  "limited time offer",
  "click here",
  "weird trick",
  "work from home",
  "crypto investment",
  "cryptocurrency investment",
  "bitcoin investment",
  "guaranteed 300% returns",
  "viagra",
  "cialis",
  "weight loss pill",
  "weight loss secret",
  "casino",
  "winning number",
  "prize draw",
  "urgent business proposal",
  "i am a bank officer",
  "unsubscribe here",
  "you have won a brand new iphone",
  "mailbox has exceeded its storage limit",
  "unpaid customs fee",
  "package could not be delivered",
  "exclusive offer",
  "90% off",
  "increase your shipping revenue with this",
];

const INVOICE_PHRASES = [
  "query on invoice",
  "requesting to cancel invoice",
  "credit note",
  "debit note",
  "debit memo",
  "d&d",
  "d & d",
  "detention",
  "demurrage",
  "telex release charges",
  "local charge",
  "outstanding invoice",
  "outstanding payment",
  "payment query",
  "payment advice",
  "payment reminder",
  "billing query",
  "billing issue",
  "charge breakdown",
  "overcharge",
  "remittance advice",
  "missing gr",
  "gr is still missing",
  "post the gr",
  "reverse the pgi",
];

const SI_REQUEST_PHRASES = [
  "please find shipping instruction for",
  "shipping instruction",
  "si needed",
  "si required",
  "new si",
  "amend si",
  "amending si",
  "kindly issue si",
  "issue si",
  "prepare si",
  "si attached for your reference",
  "please find si attached",
];

const GENERAL_PHRASES = [
  "vessel schedule",
  "sailing schedule",
  "schedule update",
  "holiday notice",
  "office will be closed",
  "office is closed",
  "noted with thanks",
  "acknowledged with thanks",
  "outstanding bl list",
  "outstanding bl summary",
  "list of outstanding bl",
  "please be informed",
  "kindly note",
  "delivery planning",
  "berthing report",
  "berthed on schedule",
  "update summary for",
  "loading completed",
  "happy and prosperous new year",
  "office resumes normal operations",
  "please submit si & aed",
  "completed successfully. no action required",
  "automated notification",
];

// Short tokens that need a word boundary instead of a bare substring check, so "eta" doesn't
// fire inside "metadata" etc. Everything else above is long enough to be safe as plain includes().
const GENERAL_WORDS = ["eta", "etd", "fyi"];
const INVOICE_WORDS = ["thc", "gr"];

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text);
}

function hasPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

export function classifyByRules(email: EmailRecord): Classification | null {
  const raw = `${email.subject}\n${cleanBody(email.body)}`.toLowerCase();
  const gateText = raw.replaceAll(FORWARD_LOOKING_SI_TAIL, "");

  // Anything that smells like a document check is always handed to the AI classifier.
  if (hasPhrase(gateText, BL_COMPARISON_PHRASES)) return null;

  const hits: Category[] = [];
  if (hasPhrase(raw, SPAM_PHRASES)) hits.push("SPAM");
  if (hasPhrase(raw, INVOICE_PHRASES) || INVOICE_WORDS.some((w) => hasWord(raw, w))) hits.push("INVOICE_QUERY");
  if (hasPhrase(raw, SI_REQUEST_PHRASES)) hits.push("SI_REQUEST");
  if (hasPhrase(raw, GENERAL_PHRASES) || GENERAL_WORDS.some((w) => hasWord(raw, w))) hits.push("GENERAL");

  // Zero hits (no phrase fired) or more than one (conflicting signals) - both ambiguous, let AI decide.
  const unique = [...new Set(hits)];
  if (unique.length !== 1) return null;

  return {
    category: unique[0],
    confidence: 0.9,
    reason: "rule match on subject/body keywords",
    expects_attachment: true, // unused outside BL_COMPARISON, which rules never return
  };
}
