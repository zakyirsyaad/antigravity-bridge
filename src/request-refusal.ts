/**
 * Telling a request Google refuses apart from a per-minute rate limit.
 *
 * Both arrive as HTTP 429 "Resource has been exhausted (e.g. check quota)." with no reset. On
 * 2026-11-21 Google answered that, on every account and model, to any request whose system
 * instruction said "You are Hermes Agent," and answered the same request without that line. So
 * when a pool runs out on reset-less 429s it asks once more: a neutral request of the same size,
 * to the same model, on an account that just answered 429. An answer rules out both the account's
 * rate limit and the request's size, which leaves the request's content.
 *
 * The same size matters: a small request passing proves nothing about a large one, which a real
 * tokens-per-minute limit refuses while letting small ones through.
 */
import { upstreamTimeoutMs } from "./upstream-stall";

/** Past this size the comparison is not asked: it would cost that many input tokens to learn it. */
export const COMPARISON_MAX_CHARS = 400_000;
/** The comparison waits no longer than this, whatever the upstream timeout is set to. */
const COMPARISON_TIMEOUT_CAP_MS = 30_000;
/** Only the status is read, so the answer is kept short. */
const COMPARISON_MAX_OUTPUT_TOKENS = 32;
const FILLER = "The quick brown fox jumps over the lazy dog. ";
const QUESTION = "Reply with the single word OK.";

export interface ComparisonRequest {
  contents: Array<{ role: "user"; parts: Array<{ text: string }> }>;
  generationConfig: { maxOutputTokens: number };
}

export function comparisonTimeoutMs(): number {
  return Math.min(upstreamTimeoutMs(), COMPARISON_TIMEOUT_CAP_MS);
}

/**
 * A neutral request about as large as `request` and carrying none of it, or null when `request`
 * is too large to be worth repeating.
 */
export function comparisonRequest(request: unknown): ComparisonRequest | null {
  const size = JSON.stringify(request ?? {}).length;
  if (size > COMPARISON_MAX_CHARS) return null;
  const filler = FILLER.repeat(Math.floor(size / FILLER.length));
  return {
    contents: [{ role: "user", parts: [{ text: `${filler}${QUESTION}` }] }],
    generationConfig: { maxOutputTokens: COMPARISON_MAX_OUTPUT_TOKENS },
  };
}

/**
 * Google answered 429 to this request and then answered the comparison. Deliberately not an
 * `UpstreamError`: Google's status was 429, and code that reads Google's status would take this
 * for a rate limit, which is the one thing it is known not to be. The server answers it as a 400.
 */
export class RequestRefusedError extends Error {
  public readonly kind = "request_refused" as const;

  constructor(message: string) {
    super(message);
    this.name = "RequestRefusedError";
  }
}
