/** `npm run check-key` - proves the key + model work, and that scanned PDFs are read, in about 10 seconds. */
import { loadEnvLocal } from "./env";
import { listModels } from "./models";
import { apiKey, callGemini, getBaseUrl, getModel, GeminiHttpError } from "../lib/gemini";
import { loadAttachment } from "../lib/attachments";
import { extractDocument } from "../lib/pipeline";

const mask = (k?: string) => (k ? `${k.slice(0, 5)}…${k.slice(-3)} (${k.length} chars)` : "(not set)");

async function main() {
  const shellKey = process.env.GEMINI_API_KEY;
  loadEnvLocal();
  console.log("API key   :", mask(process.env.GEMINI_API_KEY));
  if (shellKey && shellKey !== process.env.GEMINI_API_KEY) console.log("            (a different GEMINI_API_KEY was set in your shell - .env.local wins here)");
  console.log("Model     :", getModel(), "\nEndpoint  :", getBaseUrl(), "\n");

  try {
    apiKey();
    const out = await callGemini([{ text: 'Reply with exactly this JSON: {"ok": true}' }]);
    console.log("1/2 key + model: OK ->", out.trim().slice(0, 60));
  } catch (e) {
    const err = e as GeminiHttpError;
    console.log(`1/2 key + model: FAILED (${err.status ?? "?"}) ${err.message}\n`);
    if (err.status === 404) {
      console.log("The model id was not found. Models your key can use (copy one into GEMINI_MODEL):");
      try {
        (await listModels()).forEach((m) => console.log("  ", m));
      } catch (e2) {
        console.log("   could not list models:", (e2 as Error).message);
      }
    } else if (err.status === 400 || err.status === 401 || err.status === 403) {
      console.log("Google rejected the key itself. Create a new key in AI Studio (\"Create API key in new project\"),");
      console.log("paste it into .env.local, and run this again. If it keeps failing, it is an account-side issue.");
    }
    process.exit(1);
  }

  const [si, bl] = await Promise.all(["SI", "BL"].map((k) => loadAttachment(`attachments/email_512_${k}.pdf`)));
  for (const [name, doc] of [["SI", si], ["BL", bl]] as const) {
    if (doc.kind === "error") return console.log(`2/2 scan test: could not load ${name}: ${doc.reason}`);
    const ex = await extractDocument(doc, name);
    const f = ex.fields;
    console.log(`2/2 scanned ${name} read as ->`, JSON.stringify({ type: ex.doc_type, shipper: f.shipper.value, consignee: f.consignee.value, pol: f.port_of_loading.value, pod: f.port_of_discharge.value, containers: f.container_count.value, kg: f.gross_weight_kg.value }));
  }
  console.log("\nIf those scanned values look like real names/ports/numbers, you are ready: npm run batch");
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});
