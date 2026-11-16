/**
 * Accounts resting after a per-minute 429 exhausted the pool, in memory, by email.
 *
 * Separate from the quota cooldown (nothing is written to disk: the limit clears
 * within a minute) and from the stall rest (a stall says nothing about rate
 * limits). A retry inside the rest fails fast instead of burning one upstream
 * attempt per account inside the same saturated minute.
 */
import { RestBook, restSecondsFromEnv } from "./rest-book";

/** Matches the Retry-After hint a transient 429 gives, so a client honoring it arrives after the rest. */
const DEFAULT_REST_SECONDS = 60;

/** How long accounts rest after a transient pool exhaustion (at most a year). */
export function rateRestSeconds(): number {
  return restSecondsFromEnv("BRIDGE_RATE_REST_SECONDS", DEFAULT_REST_SECONDS);
}

/** Accounts resting after a per-minute 429, by email. Not the stall rest, not quota. */
export const RateLimitRests = new RestBook();
