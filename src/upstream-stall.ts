/**
 * When Google stops answering.
 *
 * A stall is not a 429 and not a 503: the request is accepted and then held, with
 * no response at all, in bursts that last several minutes on one account. Retrying
 * the same account three times just spends three minutes inside the burst, so the
 * first timeout rotates to another account instead, and the stalled one is rested
 * here — in memory, for a few minutes. It is deliberately not a quota cooldown:
 * the account is not out of quota, it is not answering, and the quota file (and the
 * dashboard built on it) should keep meaning "out of quota".
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_REST_SECONDS = 300;

/** How long a request waits for Google's first response before giving up on it. */
export function upstreamTimeoutMs(): number {
  const configured = Number(process.env.BRIDGE_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_TIMEOUT_MS;
}

/** How long an account that stalled is left alone before it is chosen again. */
export function stallRestSeconds(): number {
  const configured = Number(process.env.BRIDGE_STALL_REST_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_REST_SECONDS;
}

/** Rotations one request may spend on stalls: three accounts tried, never the whole pool. */
export const MAX_STALL_ROTATIONS = 2;

/** Google did not answer within the timeout. Surfaces to the caller as a 500, as before. */
export class UpstreamStall extends Error {
  public readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`No response from Google within ${Math.round(timeoutMs / 1000)}s (${url})`);
    this.name = "UpstreamStall";
    this.timeoutMs = timeoutMs;
  }
}

/** Accounts that stalled recently, by email, with when each may be used again. */
export class StallRegistry {
  private static restingUntil = new Map<string, number>();

  /** Leave an account alone for a while. `now` is injectable for tests. */
  static rest(email: string | undefined, seconds: number = stallRestSeconds(), now: number = Date.now()): void {
    if (!email) return;
    this.restingUntil.set(email.toLowerCase(), now + seconds * 1000);
  }

  static isResting(email: string | undefined, now: number = Date.now()): boolean {
    if (!email) return false;
    const until = this.restingUntil.get(email.toLowerCase());
    if (until === undefined) return false;
    if (now >= until) {
      this.restingUntil.delete(email.toLowerCase());
      return false;
    }
    return true;
  }

  static clear(): void {
    this.restingUntil.clear();
  }
}
