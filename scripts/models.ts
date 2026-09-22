import { getBaseUrl, keyHeaders } from "../lib/gemini";

/** Model ids (that support generateContent) visible to this API key. */
export async function listModels(): Promise<string[]> {
  const res = await fetch(`${getBaseUrl()}/models?pageSize=200`, { headers: keyHeaders() });
  const json = (await res.json()) as { error?: { message?: string }; models?: { name: string; supportedGenerationMethods?: string[] }[] };
  if (!res.ok) throw new Error(json.error?.message ?? res.statusText);
  return (json.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /gemini/.test(n))
    .sort();
}
