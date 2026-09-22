# SDOC Verifier - shipping document checks, from inbox to discrepancy report

Gemini reads the inbox, finds the document-check requests, reads the Shipping Instruction (SI) and draft Bill of
Lading (BL) - text, Word, Excel, PDF **and scanned image-only PDFs** - compares the 7 fields, and shows the mismatches
side by side. Anything it cannot decide goes to a person with the source evidence and a reason.

## How it works

| Stage | What runs | Where |
|---|---|---|
| 1. Classify | Gemini, 8 emails per call, JSON out: `BL_COMPARISON / SI_REQUEST / INVOICE_QUERY / GENERAL / SPAM` (intent from the body, not the misleading subject) | `lib/pipeline.ts` |
| 1b. Triage no-attachment cases | For `BL_COMPARISON` with zero attachments, Gemini also flags whether the wording implies documents should already be attached (`expects_attachment`). A forward-looking "please send the draft BL for checking" is just classified as `OK` - nothing to compare yet, and that's expected. A message that claims something is attached but isn't still goes to `NEEDS_REVIEW`. | `lib/prompts.ts`, `checkEmail` in `lib/pipeline.ts` |
| 2. Extract | Gemini reads each attachment. Text/Word/Excel are converted to text, PDFs and scans go in natively (vision). Returns the 7 fields + evidence snippet + doc type + readable flag. Labels are matched by meaning (`Load Port` = `Port of Loading`, `To the Order of` = consignee). | `lib/pipeline.ts`, `lib/prompts.ts` |
| 3. Compare | Deterministic code: ignores case/punctuation/`LTD` vs `LIMITED`, drops country and `Port of`, matches UN/LOCODEs, parses `1,234 KG`, derives totals from container tables. No LLM in the final verdict, so no false alarms from model whims. | `lib/normalize.ts`, `lib/compare.ts` |
| 3b. Explain | For a confirmed `MISMATCH`, Gemini writes a short plain-English note on what differs (only from the already-confirmed defect fields - it cannot introduce a new mismatch). If this call fails, the mismatch is still reported, just without the note. | `explainMismatch` in `lib/pipeline.ts` |
| 4. Human in the loop | `NEEDS_REVIEW` with a reason (`missing_attachment`, `unreadable`, `wrong_doc_type`, `missing_value`), the source PDF embedded, an editable form, instant recompute. Failures are shown and retryable. | `components/ReviewForm.tsx`, `lib/overrides.ts` |

Why Gemini is a key component: without it the system cannot read scans, cannot understand a request written in free
text, and cannot align differently labelled fields across layouts.

## Run it

```bash
npm install
cp .env.example .env.local        # Windows: copy .env.example .env.local  -> then paste your Gemini key inside
npm run check-key                 # 10-second proof that key + model work and scanned PDFs are read
npm run test                      # comparison rules
npm run batch                     # processes all 520 emails -> data/report.json + submission.json (resumable)
npm run dev                       # dashboard at http://localhost:3000
```

Default model is `gemini-3.1-flash-lite` (change `GEMINI_MODEL` in `.env.local`; `check-key` prints the model ids your
key can use if the name is not found). The Gemini REST API is called directly (`lib/gemini.ts`, `x-goog-api-key`
header), so both `AIza...` and the new `AQ....` AI Studio keys work the same way. Values in `.env.local` override any
`GEMINI_API_KEY` already set in your shell when running the scripts.

Gemini 3 models "think" before answering, and that thinking spends from the same output-token budget as the
answer itself - on a small budget the model can spend it all thinking and return nothing (`finishReason:
"MAX_TOKENS"`). This is retried automatically: `generateJson` in `lib/gemini.ts` detects that specific failure
and retries immediately with double the token budget (default `8192`, doubling up to `32768`), no backoff wait.
Rate limits and server errors still back off and retry as before. Override the starting budget with
`GEMINI_MAX_OUTPUT_TOKENS` in `.env.local` if you see this a lot.

`npm run batch -- --only email_004,email_512` re-runs specific emails. Re-running `npm run batch` only retries what
failed (successes are cached in `.cache/`). A rejected key or unknown model stops the batch immediately instead of
producing a report full of errors.

## Two datasets

- **`data/`** - the small toy set from the participant bundle. Default; nothing to configure.
- **`data_v2/`** - the larger, realistic set (520 emails, real carrier/port names, PDF/DOCX/XLSX,
  20 reliability edge cases) from the organizers' docker bundle. It's included here **without**
  `ground_truth.json` - only `inbox/`, `attachments/` and the blank `sample_submission.json` shape.

To run against `data_v2`, add one line to `.env.local`:
```
DATA_DIR=./data_v2
```
Then `npm run check-key`, `npm run batch`, `npm run dev` as usual. The `.cache/` folder is
namespaced per dataset, so switching `DATA_DIR` back and forth never mixes up cached results
from the two sets.

## Self-evaluation (scores without ever seeing the answer key)

The organizers' docker bundle (a separate zip, **not** part of this repo - it contains
`ground_truth.json` and is explicitly marked "do not hand to participants") runs a small FastAPI
server. Unzip *that* bundle somewhere else and start it:

```bash
docker compose up --build     # serves on http://localhost:8080
```

Then, from this project:
```bash
npm run score                 # POSTs submission.json to :8080/submit, prints the scoreboard
```

`POST /submit` scores your submission server-side against the private ground truth and returns
only a scoreboard (per-category accuracy, mismatch precision/recall, etc.) - the correct answers
themselves are never returned by any endpoint. That's the intended, fair way to check your score;
don't open `ground_truth.json` and compare it to your output by hand, since that defeats the
point of the check and risks disqualification under the hackathon's rules against tampering with
results.

## Deploy on Vercel

1. Run `npm run batch` locally and commit `data/report.json`.
2. Import the repo in Vercel, set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`).
3. Deploy. The dashboard shows the precomputed report; **Live check** and **Re-run with Gemini** call Gemini live
   (routes allow up to 60 s).

## Known limits / roadmap

- Human reviews are stored in the browser (localStorage); next step is a database (Vercel Postgres/KV) and reviewer accounts.
- Port comparison ignores the country; a same-name port in another country would not be flagged.
- Live routes read the bundled sample inbox; next step is IMAP / Gmail / Microsoft Graph ingestion and a queue for large volumes.
