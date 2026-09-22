import fs from "node:fs";

/** Loads .env.local / .env into process.env. Values in the file WIN over anything already in the shell. */
export function loadEnvLocal() {
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    for (const raw of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !raw.trim().startsWith("#")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
