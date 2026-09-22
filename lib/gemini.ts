/**
 * Minimal Gemini client over the plain REST API (no SDK). The key is sent in the
 * `x-goog-api-key` header, which is what Google documents for both AIza and AQ. keys.
 * Settings are read at call time so scripts can load .env.local first.
 */
export const getBaseUrl = () => process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_MODEL = "gemini-3.1-flash-lite";
export const getModel = () => (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export class ValidationError extends Error {}

export class GeminiHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
  /** Errors that retrying will not fix: bad key, bad request, unknown model. */
  get fatal() {
    return [400, 401, 403, 404].includes(this.status);
  }
}

/**
 * Gemini 3 models "think" before answering, and that thinking spends from the same
 * maxOutputTokens budget as the visible answer. On a small budget the model can spend it
 * all thinking and hit MAX_TOKENS before writing any answer text - an empty response that
 * isn't a rate limit or a bad request, so plain retry-with-backoff would just repeat it.
 * generateJson() catches this specifically and retries with more room instead.
 */
export class TokenLimitError extends Error {
  constructor(public maxOutputTokens: number) {
    super(`hit the output token limit (${maxOutputTokens}) before producing an answer`);
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192;

export function apiKey(): string {
  const k = (process.env.GEMINI_API_KEY || "").trim();
  if (!k || k === "your-key-here") throw new GeminiHttpError(401, "GEMINI_API_KEY is not set (put it in .env.local, or in Vercel environment variables)");
  return k;
}

export const keyHeaders = () => ({ "Content-Type": "application/json", "x-goog-api-key": apiKey() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One raw call. Returns the model's text. */
export async function callGemini(
  parts: Part[],
  system?: string,
  model = getModel(),
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
): Promise<string> {
  const generationConfig: Record<string, unknown> = { responseMimeType: "application/json", maxOutputTokens };
  if (process.env.GEMINI_TEMPERATURE) generationConfig.temperature = Number(process.env.GEMINI_TEMPERATURE);
  const body: Record<string, unknown> = { contents: [{ role: "user", parts }], generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(`${getBaseUrl()}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: keyHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  } | null;

  if (!res.ok) throw new GeminiHttpError(res.status, json?.error?.message ?? res.statusText);

  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text.trim()) {
    if (cand?.finishReason === "MAX_TOKENS") throw new TokenLimitError(maxOutputTokens);
    const why = cand?.finishReason ?? json?.promptFeedback?.blockReason;
    throw new ValidationError(`empty model response${why ? ` (${why})` : ""}`);
  }
  return text;
}

/**
 * JSON-mode call with validation and retries: rate limits and 5xx back off and retry
 * unchanged; a token-starved response (see TokenLimitError above) retries immediately with
 * a bigger output budget instead of waiting, since waiting wouldn't have helped.
 */
export async function generateJson<T>(
  parts: Part[],
  systemInstruction: string,
  validate: (raw: unknown) => T,
  attempts = 5,
): Promise<T> {
  let lastError: unknown;
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  for (let i = 0; i < attempts; i++) {
    try {
      const text = (await callGemini(parts, systemInstruction, undefined, maxOutputTokens))
        .replace(/^\s*```(?:json)?/i, "")
        .replace(/```\s*$/, "")
        .trim();
      return validate(JSON.parse(text));
    } catch (e) {
      lastError = e;
      if (e instanceof TokenLimitError) {
        maxOutputTokens = Math.min(maxOutputTokens * 2, 32768); // give the next attempt more room to think AND answer
        continue; // no backoff sleep - a bigger budget, not time, is what might fix this
      }
      if ((e instanceof GeminiHttpError && e.fatal) || i === attempts - 1) break;
      await sleep(2000 * 2 ** i + Math.random() * 800);
    }
  }
  throw lastError;
}
