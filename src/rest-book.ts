/**
 * Accounts set aside for a while, in memory, by email (case-insensitive).
 *
 * Shared by the CloudCode stall rest (StallRegistry) and Gemini Web's session rest
 * (WebSessionRests). Each keeps its own book: a CloudCode account that stalled says
 * nothing about the same person's Gemini Web session, and the reverse.
 */

/** A year. Longer is no rest, and a huge value puts the rest's end past what a Date holds, which /api/pool prints. */
export const MAX_REST_SECONDS = 365 * 24 * 60 * 60;

/** A rest length from the environment variable `name`: a positive number of seconds, at most a year. */
export function restSecondsFromEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), MAX_REST_SECONDS)
    : fallback;
}

export class RestBook {
  private restingUntil = new Map<string, number>();

  /** Leave an account alone for `seconds`. `now` is injectable for tests. */
  rest(email: string | undefined, seconds: number, now: number = Date.now()): void {
    if (!email) return;
    this.restingUntil.set(email.toLowerCase(), now + seconds * 1000);
  }

  isResting(email: string | undefined, now: number = Date.now()): boolean {
    return this.restEndsAt(email, now) !== null;
  }

  /** When an account's rest ends (epoch ms), or null when it is not resting. */
  restEndsAt(email: string | undefined, now: number = Date.now()): number | null {
    if (!email) return null;
    const until = this.restingUntil.get(email.toLowerCase());
    if (until === undefined) return null;
    if (now >= until) {
      this.restingUntil.delete(email.toLowerCase());
      return null;
    }
    return until;
  }

  /** End one account's rest early (it answered). */
  end(email: string | undefined): void {
    if (email) this.restingUntil.delete(email.toLowerCase());
  }

  clear(): void {
    this.restingUntil.clear();
  }
}
