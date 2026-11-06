/**
 * Accounts set aside for a while, in memory, by email (case-insensitive).
 *
 * Shared by the CloudCode stall rest (StallRegistry) and Gemini Web's session rest
 * (WebSessionRests). Each keeps its own book: a CloudCode account that stalled says
 * nothing about the same person's Gemini Web session, and the reverse.
 */
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
