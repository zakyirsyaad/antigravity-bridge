import { UpstreamError } from "./upstream-error";
import { upstreamTimeoutMs } from "./upstream-stall";
import type { FailoverReason } from "./oauth";

/**
 * How one pass over one account ended. Each kind the run can end on gets its own
 * wording in `PoolFailures.exhaustedError()`; one without a case there keeps the
 * caller's.
 */
export type FailureKind =
  | "quota" // 429: the caller keeps the rate-limited wording
  | "capacity" // 503 "No capacity available for model X on the server"
  | "unavailable" // any other 503
  | "stall" // Google accepted the request and never answered
  | "other"; // a network error, a 401, anything not reported here

export interface AttemptOutcome {
  hit429: boolean;
  hit503: boolean;
  /** Google's own message for the 503, when there was one. */
  message503: string;
  stalled: boolean;
  /** For a stall, how many attempts waited out the full timeout (1 when unset). */
  stallAttempts?: number;
}

const NO_CAPACITY = /no capacity/i;

/**
 * The failover event's name for each way an attempt can end; `null` is one the pool does not move
 * on. A `Record` over `FailureKind`, so a kind added there without a reason here fails to compile.
 */
const REASON_OF_KIND: Record<FailureKind, FailoverReason | null> = {
  quota: "quota",
  capacity: "no_capacity",
  unavailable: "unavailable",
  stall: "stall",
  other: null,
};

/** Why a 429 or 503 moved the pool on, for the failover event the dashboard shows. */
export function rotationReason(hit429: boolean, message503: string): FailoverReason {
  return REASON_OF_KIND[classify({ hit429, hit503: !hit429, message503, stalled: false })] ?? "unavailable";
}

/**
 * The error a run ends with when `PoolFailures` words it. The kind is carried as
 * data so the server can choose the error type without reading the message: only
 * "capacity" is a model overload, a generic 503 is an outage.
 */
export class PoolExhaustedError extends UpstreamError {
  public readonly kind: FailureKind;

  constructor(kind: FailureKind, status: number, message: string) {
    super(status, message);
    this.name = "PoolExhaustedError";
    this.kind = kind;
  }
}

/**
 * The error a run ends with when Google stopped answering. Deliberately not an
 * `UpstreamError`: that type means "Google answered with this status", and Google
 * answered nothing. With no status the server answers its generic 500, as a stall
 * always was, and code that reads Google's status cannot mistake it for a 500 from
 * Google.
 */
export class PoolStalledError extends Error {
  public readonly kind = "stall" as const;

  constructor(message: string) {
    super(message);
    this.name = "PoolStalledError";
  }
}

function classify(outcome: AttemptOutcome): FailureKind {
  if (outcome.hit429) return "quota";
  if (outcome.hit503) return NO_CAPACITY.test(outcome.message503) ? "capacity" : "unavailable";
  if (outcome.stalled) return "stall";
  return "other";
}

/**
 * Why the pool's accounts failed during one request, so that running out of them
 * can say which it was.
 *
 * Running out used to read "All accounts in the pool are currently rate limited.
 * Please wait for cooldown to reset." whatever happened: gemini-2.5-pro answered
 * 503 "no capacity" on all six accounts and that is what the caller saw, which sent
 * people to the quota file for a cooldown no 503 ever writes. The wording now
 * follows the failure that ended the run; a run that ends on a 429 keeps the old one.
 *
 * A stall reached the same message: Google accepted the request and never answered,
 * which writes no quota cooldown, and the pool rotated back to an account that had
 * answered 503 and ran out of passes.
 *
 * Accounts are counted by email, not by pass: a 503 writes no cooldown, so the
 * selector can come back to an account already tried while skipping a cooling one.
 */
export class PoolFailures {
  private readonly tried = new Set<string>();
  private readonly byKind = new Map<FailureKind, Set<string>>();
  private last: { kind: FailureKind; message503: string; stallAttempts: number } | null = null;

  record(email: string | undefined, outcome: AttemptOutcome): void {
    const account = email || "(active account)";
    const kind = classify(outcome);
    this.tried.add(account);
    this.byKind.set(kind, new Set(this.byKind.get(kind)).add(account));
    this.last = { kind, message503: outcome.message503, stallAttempts: outcome.stallAttempts ?? 1 };
  }

  /** The error to end the run with, or null to keep the caller's own. */
  exhaustedError(model: string): PoolExhaustedError | PoolStalledError | null {
    if (!this.last) return null;
    const google = this.last.message503 ? ` (Google: ${this.last.message503})` : "";
    switch (this.last.kind) {
      case "capacity":
        return new PoolExhaustedError(
          "capacity",
          503,
          `Google has no capacity for model ${model} right now: ${this.describe("capacity")} answered ` +
            `HTTP 503 "no capacity". This is Google-side capacity, not quota — no account was put on ` +
            `cooldown, and there is no cooldown to wait out. Retry shortly, or use another model.${google}`
        );
      case "unavailable":
        return new PoolExhaustedError(
          "unavailable",
          503,
          `Google answered HTTP 503 (service unavailable) for model ${model}: ${this.describe("unavailable")} ` +
            `answered it. This is on Google's side, not quota — no account was put on cooldown, and there ` +
            `is no cooldown to wait out. Retry shortly.${google}`
        );
      case "stall": {
        // Nothing is said about resting, because a pool that retried in place
        // rested nothing. A pool that retried in place waited more than once, so
        // the wait is said as it happened.
        const seconds = Math.round(upstreamTimeoutMs() / 1000);
        const attempts = this.last.stallAttempts;
        const waited = attempts > 1 ? `to ${attempts} attempts of ${seconds}s each` : `within ${seconds}s`;
        return new PoolStalledError(
          `Google stopped answering requests for model ${model}: ${this.describe("stall")} gave no ` +
            `response ${waited} (upstream stall / timeout). This is not quota — no account was put on ` +
            `cooldown, and there is no cooldown to wait out. Retry in a few minutes.`
        );
      }
      default:
        return null;
    }
  }

  /** "all 6 accounts tried", "both accounts tried", "2 of 3 accounts tried". */
  private describe(kind: FailureKind): string {
    const hits = this.byKind.get(kind)?.size ?? 0;
    const tried = this.tried.size;
    if (hits < tried) return `${hits} of ${tried} accounts tried`;
    if (tried === 1) return "the account tried";
    if (tried === 2) return "both accounts tried";
    return `all ${tried} accounts tried`;
  }
}
