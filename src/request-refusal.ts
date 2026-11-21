/**
 * Telling a request Google refuses apart from a per-minute rate limit.
 *
 * Both arrive as HTTP 429 "Resource has been exhausted (e.g. check quota)." with no reset. On
 * 2026-11-21 Google answered that, on every account and model, to any request whose system
 * instruction said "You are Hermes Agent," and answered the same request without that line. So
 * when a pool runs out on reset-less 429s it asks once more: a neutral request of the same size,
 * to the same model, on the account that just answered 429. An answer rules out both the account's
 * rate limit and the request's size, which leaves the request's content.
 *
 * The same size matters: a small request passing proves nothing about a large one, which a real
 * tokens-per-minute limit refuses while letting small ones through. Size means tokens, which is
 * what Google limits, and characters do not predict them: Google counted prose at 4.5 characters
 * per token, a real request with tools at 4.06, JSON data at 2.4, minified code at 1.5 and CSV
 * numbers at 1.0 (2026-11-21). So Google counts the request first (`v1internal:countTokens`), and
 * the comparison is filler of a quarter more tokens than that. Without a count no comparison is
 * sent.
 * Its generation settings are the request's own, in case Google admits by the output it is asked
 * to allow. That leaves the content as the only difference.
 */
import { upstreamTimeoutMs } from "./upstream-stall";

/** Past this count the comparison is not asked: it would cost that many input tokens to learn it. */
export const COMPARISON_MAX_TOKENS = 120_000;
/** Past this length the request is not even counted: no text this long is under the token cap. */
export const COMPARISON_MAX_CHARS = 1_000_000;
/** The count and the comparison share this long, whatever the upstream timeout is set to. */
const COMPARISON_TIMEOUT_CAP_MS = 30_000;
/** Inline data is left out of the count (see countableText); an image is a few hundred tokens. */
const INLINE_PART_TOKENS = 1_000;
/**
 * `countTokens` counts `contents` only: it accepts `tools` and `systemInstruction` and ignores
 * them, so the request is counted as text. That runs low. A request with 20 tool declarations
 * counted 7,861 as text and cost 8,160 when sent (3.7% more), so the comparison gets a quarter on
 * top. Too large only costs tokens; too small calls a real limit a refusal.
 */
const COUNT_MARGIN = 1.25;
/** Two-letter words: Google counts one token per word, 3.00 characters each, for Gemini and Claude ids. */
const FILLER = "ox in at up ";
const FILLER_TOKENS = 4;
const QUESTION = "Reply with the single word OK.";

export interface ComparisonRequest {
  contents: Array<{ role: "user"; parts: Array<{ text: string }> }>;
  generationConfig?: unknown;
}

export function comparisonTimeoutMs(): number {
  return Math.min(upstreamTimeoutMs(), COMPARISON_TIMEOUT_CAP_MS);
}

/**
 * The request as one text for Google to count, tools and system instruction included. Inline
 * data is taken out, because base64 length says nothing about its tokens and it would be
 * megabytes to send again; comparisonTokens() allows for each part removed.
 */
export function countableText(request: unknown): { text: string; inlineParts: number } {
  let inlineParts = 0;
  const text =
    JSON.stringify(request ?? {}, (key, value) => {
      if (key !== "inlineData") return value;
      inlineParts++;
      return undefined;
    }) ?? "";
  return { text, inlineParts };
}

/** The tokens the comparison needs, from Google's count of countableText(): never fewer than the request costs. */
export function comparisonTokens(countedTokens: number, inlineParts: number): number {
  return Math.ceil(countedTokens * COUNT_MARGIN) + inlineParts * INLINE_PART_TOKENS;
}

/**
 * A neutral request of at least `tokens` tokens, with `request`'s generation settings and none
 * of its content.
 */
export function comparisonRequest(tokens: number, request: unknown): ComparisonRequest {
  const filler = FILLER.repeat(Math.ceil(tokens / FILLER_TOKENS));
  const generationConfig = (request as { generationConfig?: unknown } | null | undefined)?.generationConfig;
  return {
    contents: [{ role: "user", parts: [{ text: `${filler}${QUESTION}` }] }],
    ...(generationConfig ? { generationConfig } : {}),
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
