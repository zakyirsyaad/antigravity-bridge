/**
 * Regression guard for a pool that runs out on 429s Google words as a per-minute
 * rate limit, not a quota window.
 *
 * Observed 2026-11-16: every pooled account answered 429 within a second while
 * Google's own 5h/weekly meters read 97-100% and the quota file gained no entry,
 * because the 429 message carries no "Resets in ..." for record429() to parse.
 * The caller was told "All accounts in the pool are currently rate limited.
 * Please wait for cooldown to reset." — a cooldown that does not exist and never
 * resets, while the real limit clears within a minute.
 *
 * A 429 that DID write a cooldown keeps the old wording: there is a real reset
 * to wait out then.
 *
 * Stubbed throughout — no disk, network, credential or quota writes. record429
 * itself runs real (its load/save are stubbed) so the parse decides the outcome.
 */
import { AntigravityClient, UpstreamError } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { PoolExhaustedError } from "../src/pool-failures";
import { sendUpstreamRateLimited } from "../src/server";

const A = { email: "a@example.com", projectId: "p", refreshToken: "r" };
const B = { email: "b@example.com", projectId: "p", refreshToken: "r" };
const C = { email: "c@example.com", projectId: "p", refreshToken: "r" };

let pool: any[] = [A, B, C];
let current: any = A;
let attempts: string[] = [];
let respond: (account: any) => Response = () => new Response("{}", { status: 200 });

(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => true;
(OAuthManager.prototype as any).listAccounts = () => ({ accounts: pool, activeIndex: pool.indexOf(current) });
(OAuthManager.prototype as any).selectNextAvailableAccount = () => {
  const next = pool[(pool.indexOf(current) + 1) % pool.length];
  if (next === current) return null;
  current = next;
  return current;
};
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
// record429 stays real; only its disk is stubbed, so the message parse decides.
(QuotaTracker.prototype as any).load = () => ({ perAccount: {} });
(QuotaTracker.prototype as any).save = () => {};

(globalThis as any).fetch = async () => {
  attempts.push(current.email);
  return respond(current);
};

const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

/** A per-minute limit: no reset duration anywhere in the message. */
const TRANSIENT = "Resource has been exhausted (e.g. check quota).";
/** A quota window: parseable reset, so a cooldown is written. */
const QUOTA = "Individual quota reached. Resets in 3h55m50s.";
const RATE_LIMITED = "All accounts in the pool are currently rate limited. Please wait for cooldown to reset.";
const payload = {
  model: "gemini-3.8-flash-tiered",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
};

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function caught(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function reset(responder: (account: any) => Response) {
  pool = [A, B, C];
  current = A;
  attempts = [];
  respond = responder;
}

/** What a client must be told when the limit clears in a minute, not hours. */
function expectTransientError(label: string, err: any) {
  const message = String(err?.message);
  expect(`${label}: is a PoolExhaustedError`, err instanceof PoolExhaustedError, true);
  expect(`${label}: carries status 429`, err?.status, 429);
  expect(`${label}: kind is quota, as data`, err?.kind, "quota");
  expect(`${label}: asks for a 60s retry`, err?.retryAfterSeconds, 60);
  expect(`${label}: names the model`, message.includes(payload.model), true);
  expect(`${label}: says per-minute`, /per-minute/i.test(message), true);
  expect(`${label}: says no cooldown was recorded`, /no quota cooldown/i.test(message), true);
  expect(`${label}: keeps Google's own message`, message.includes(TRANSIENT), true);
  expect(`${label}: does not promise a cooldown reset`, /cooldown to reset/i.test(message), false);
}

async function runTests() {
  console.log("=================================================");
  console.log(" Transient per-minute 429 vs real quota cooldown");
  console.log("=================================================\n");

  const client = new AntigravityClient();

  console.log("[1/7] A pool exhausted on reset-less 429s says per-minute, not cooldown ...");
  reset(() => fail(429, TRANSIENT));
  let err = await caught(() => client.generateContent(payload as any));
  expectTransientError("generateContent", err);
  expect("every account was tried", attempts.length, 3);

  console.log("\n[2/7] ... on the streaming path too ...");
  reset(() => fail(429, TRANSIENT));
  err = await caught(() => client.streamGenerateContent(payload as any));
  expectTransientError("streamGenerateContent", err);

  console.log("\n[3/7] A 429 that wrote a cooldown keeps the quota wording ...");
  reset(() => fail(429, QUOTA));
  err = await caught(() => client.generateContent(payload as any));
  expect("wording unchanged", err?.message, RATE_LIMITED);
  expect("no 429 status invented", err?.status, undefined);
  expect("no retry-after invented", err?.retryAfterSeconds, undefined);

  console.log("\n[4/7] ... even when a later account's 429 carried no reset ...");
  reset((acct) => (acct === A ? fail(429, QUOTA) : fail(429, TRANSIENT)));
  err = await caught(() => client.generateContent(payload as any));
  expect("one real cooldown keeps the quota wording", err?.message, RATE_LIMITED);
  expect("no retry-after when a cooldown exists", err?.retryAfterSeconds, undefined);

  console.log("\n[5/7] record429 reports whether it wrote a window ...");
  const tracker = QuotaTracker.getInstance();
  expect("reset-less message writes nothing", tracker.record429(A.email, TRANSIENT, payload.model), false);
  expect("reset-bearing message writes a window", tracker.record429(A.email, QUOTA, payload.model), true);

  console.log("\n[6/7] The server answers a real 429 with Retry-After ...");
  expect("helper is exported", typeof sendUpstreamRateLimited, "function");
  if (typeof sendUpstreamRateLimited === "function") {
    const captured: any = { headers: null, body: "" };
    const res: any = {
      headersSent: false,
      writeHead(status: number, headers: any) {
        captured.status = status;
        captured.headers = headers;
      },
      end(body: string) {
        captured.body = body;
      },
    };
    reset(() => fail(429, TRANSIENT));
    err = await caught(() => client.generateContent(payload as any));
    sendUpstreamRateLimited(res, "/v1/chat/completions", err);
    expect("status 429 on the wire", captured.status, 429);
    expect("Retry-After header", captured.headers?.["Retry-After"], "60");
    expect("error type rate_limit_error", JSON.parse(captured.body)?.error?.type, "rate_limit_error");
    expect("message reaches the client", JSON.parse(captured.body)?.error?.message, err.message);
  }

  console.log("\n[7/7] A capacity exhaustion carries no retry-after ...");
  reset(() => fail(503, "No capacity available for model gemini-3.8-flash-tiered on the server"));
  err = await caught(() => client.generateContent(payload as any));
  expect("capacity kind", err?.kind, "capacity");
  expect("capacity has no retry-after", err?.retryAfterSeconds, undefined);
  expect("capacity stays 503", err?.status, 503);
  expect("is an UpstreamError", err instanceof UpstreamError, true);

  if (failures > 0) {
    throw new Error(`${failures} transient rate-limit check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL TRANSIENT RATE-LIMIT CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
