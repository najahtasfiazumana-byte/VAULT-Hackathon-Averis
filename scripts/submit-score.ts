/**
 * Scores submission.json against the self-eval server from the ORGANIZER's docker bundle
 * (run separately: `docker compose up --build` in that folder - it serves on :8080 by
 * default). This script never touches ground_truth.json - the server keeps it private and
 * only ever returns a scoreboard.
 *
 *   npm run score                          # posts to http://localhost:8080/submit
 *   npm run score -- --url http://host:port/submit
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvLocal } from "./env";

const args = process.argv.slice(2);
const opt = (n: string) => args[args.indexOf(`--${n}`) + 1];

async function main() {
  loadEnvLocal();
  const url = opt("url") || process.env.EVAL_SERVER_URL || "http://localhost:8080/submit";
  const submissionPath = path.join(process.cwd(), "submission.json");

  let submission: unknown;
  try {
    submission = JSON.parse(await fs.readFile(submissionPath, "utf8"));
  } catch {
    console.error(`Could not read ${submissionPath} - run "npm run batch" first.`);
    process.exit(1);
  }

  console.log(`Scoring against ${url} ...`);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) });
  } catch (e) {
    console.error(`Could not reach the eval server at ${url}.`);
    console.error(`Is it running? In the organizer's docker bundle folder: docker compose up --build`);
    console.error(String((e as Error).message));
    process.exit(1);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`Server returned ${res.status}:`, body);
    process.exit(1);
  }
  console.log(JSON.stringify(body, null, 2));
}

main();
