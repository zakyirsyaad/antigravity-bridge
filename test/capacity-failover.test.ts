/**
 * Regression guard for account failover on upstream capacity errors.
 *
 * Only 429 used to rotate the pool. A 503 — "No capacity available for model X
 * on the server" — fell straight through to the caller, and since
 * ANTIGRAVITY_ENDPOINTS holds a single endpoint there was no second attempt at
 * all. It was the single largest error class in production.
 *
 * Capacity is per project, so another account is a real second chance. What a
 * 503 must NOT do is write a quota cooldown: that would park a perfectly
 * healthy account for hours over a transient server condition.
 *
 * 400 stays non-retryable — a malformed request is malformed everywhere.
 *
 * And when the pool runs out on 503s, the error has to say so. It used to read
 * "All accounts in the pool are currently rate limited. Please wait for cooldown
 * to reset." — gemini-2.5-pro answered 503 on all six accounts, and that message
 * sent people to the quota file looking for a cooldown that a 503 never writes.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import { AntigravityClient, UpstreamError } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";

const A = { email: "a@example.com", projectId: "p", refreshToken: "r" };
const B = { email: "b@example.com", projectId: "p", refreshToken: "r" };
const C = { email: "c@example.com", projectId: "p", refreshToken: "r" };

let pool: any[] = [A, B];
let current: any = A;
let failoverEnabled = true;
/** When false, selectNextAvailableAccount finds nothing to move to. */
let canRotate = true;
let switched = 0;
let cooldownsRecorded = 0;
let attempts: string[] = [];
let respond: (account: any) => Response = () => new Response("{}", { status: 200 });

(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => failoverEnabled;
// The pool size is read from here; left real, it would read ~/.zcode.
(OAuthManager.prototype as any).listAccounts = () => ({ accounts: pool, activeIndex: pool.indexOf(current) });
(OAuthManager.prototype as any).selectNextAvailableAccount = () => {
  if (!canRotate) return null;
  switched++;
  current = pool[(pool.indexOf(current) + 1) % pool.length];
  return current;
};
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {
  cooldownsRecorded++;
};

(globalThis as any).fetch = async () => {
  attempts.push(current.email);
  return respond(current);
};

const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
const okStream = () =>
  new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`, {
    status: 200,
  });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

const CAPACITY = "No capacity available for model gemini-3.8-flash-tiered on the server";
const QUOTA = "Individual quota reached. Resets in 3h55m50s.";
const RATE_LIMITED = "All accounts in the pool are currently rate limited. Please wait for cooldown to reset.";
const payload = {
  model: "gemini-3.8-flash-tiered",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
};

let failures = 0;

async function caught(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** What a client has to be told when Google, not quota, is the reason. */
function expectCapacityError(label: string, err: any) {
  const message = String(err?.message);
  expect(`${label}: is an UpstreamError`, err instanceof UpstreamError, true);
  expect(`${label}: carries status 503`, err?.status, 503);
  expect(`${label}: names the model`, message.includes(payload.model), true);
  expect(`${label}: says Google-side capacity`, message.includes("Google-side capacity, not quota"), true);
  expect(`${label}: keeps Google's own message`, message.includes(CAPACITY), true);
  expect(`${label}: does not say rate limited`, /rate limited|cooldown to reset/i.test(message), false);
}

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function reset(responder: (account: any) => Response, accounts: any[] = [A, B]) {
  pool = accounts;
  current = A;
  failoverEnabled = true;
  canRotate = true;
  switched = 0;
  cooldownsRecorded = 0;
  attempts = [];
  respond = responder;
}

async function runTests() {
  console.log("=================================================");
  console.log(" Failover on upstream capacity errors");
  console.log("=================================================\n");

  const client = new AntigravityClient();

  console.log("[1/9] A 503 rotates to another account instead of failing ...");
  reset((acct) => (acct === A ? fail(503, CAPACITY) : ok()));
  let text = "";
  try {
    const res: any = await client.generateContent(payload as any);
    text = res?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (e: any) {
    text = `THREW ${e.message}`;
  }
  expect("request ultimately succeeds", text, "ok");
  expect("rotated exactly once", switched, 1);
  expect("second attempt used the other account", attempts[attempts.length - 1], B.email);
  expect("no cooldown written for a 503", cooldownsRecorded, 0);

  console.log("\n[2/9] The streaming path rotates too ...");
  reset((acct) => (acct === A ? fail(503, CAPACITY) : okStream()));
  let streamed = "";
  try {
    const stream: any = await client.streamGenerateContent(payload as any);
    for await (const chunk of stream) {
      streamed = chunk?.candidates?.[0]?.content?.parts?.[0]?.text || streamed;
      break;
    }
  } catch (e: any) {
    streamed = `THREW ${e.message}`;
  }
  expect("stream ultimately succeeds", streamed, "ok");
  expect("rotated exactly once", switched, 1);
  expect("no cooldown written for a 503", cooldownsRecorded, 0);

  console.log("\n[3/9] 429 still rotates AND still records the cooldown ...");
  reset((acct) =>
    acct === A ? fail(429, QUOTA) : ok()
  );
  try {
    await client.generateContent(payload as any);
  } catch {}
  expect("rotated on 429", switched, 1);
  expect("cooldown recorded once", cooldownsRecorded, 1);

  console.log("\n[4/9] 400 is still refused on the spot ...");
  reset(() => fail(400, "Request contains an invalid argument."));
  let thrown = "";
  try {
    await client.generateContent(payload as any);
  } catch (e: any) {
    thrown = e.message.includes("(400)") ? "400" : e.message;
  }
  expect("threw a 400", thrown, "400");
  expect("never rotated the pool", switched, 0);
  expect("tried exactly one account", attempts.length, 1);

  console.log("\n[5/9] A pool that runs out on 503s says capacity, not rate limit ...");
  reset(() => fail(503, CAPACITY), [A, B, C]);
  let err = await caught(() => client.generateContent(payload as any));
  expectCapacityError("generateContent", err);
  expect("says every account answered 503", String(err?.message).includes("all 3 accounts tried"), true);
  expect("every account in the pool was tried", attempts.join(","), [A, B, C].map((a) => a.email).join(","));
  expect("no cooldown written for a 503", cooldownsRecorded, 0);

  console.log("\n[6/9] ... on the streaming path too ...");
  reset(() => fail(503, CAPACITY), [A, B, C]);
  err = await caught(() => client.streamGenerateContent(payload as any));
  expectCapacityError("streamGenerateContent", err);
  expect("every account in the pool was tried", attempts.length, 3);
  expect("no cooldown written for a 503", cooldownsRecorded, 0);

  console.log("\n[7/9] ... when no other account is free, and when failover is off ...");
  reset(() => fail(503, CAPACITY));
  canRotate = false;
  expectCapacityError("nowhere to rotate", await caught(() => client.generateContent(payload as any)));
  expect("nowhere to rotate: one account tried", attempts.length, 1);
  reset(() => fail(503, CAPACITY));
  failoverEnabled = false;
  err = await caught(() => client.streamGenerateContent(payload as any));
  expectCapacityError("failover off", err);
  expect("failover off: names the single account", String(err?.message).includes("the account tried"), true);

  console.log("\n[8/9] ... and counts only the accounts that answered 503 ...");
  reset((acct) => (acct === A ? fail(429, QUOTA) : fail(503, CAPACITY)), [A, B, C]);
  err = await caught(() => client.generateContent(payload as any));
  expectCapacityError("last failure a 503 after a 429", err);
  expect("says 2 of 3, not all", String(err?.message).includes("2 of 3 accounts tried"), true);
  expect("the 429 still recorded its cooldown", cooldownsRecorded, 1);

  console.log("\n[9/9] A pool that runs out on 429s keeps the quota wording ...");
  reset(() => fail(429, QUOTA), [A, B, C]);
  err = await caught(() => client.generateContent(payload as any));
  expect("generateContent: rate-limited wording unchanged", err?.message, RATE_LIMITED);
  expect("generateContent: no 503 status", err?.status, undefined);
  reset(() => fail(429, QUOTA), [A, B, C]);
  err = await caught(() => client.streamGenerateContent(payload as any));
  expect("streamGenerateContent: rate-limited wording unchanged", err?.message, RATE_LIMITED);
  reset((acct) => (acct === C ? fail(429, QUOTA) : fail(503, CAPACITY)), [A, B, C]);
  err = await caught(() => client.generateContent(payload as any));
  expect("last failure a 429 after 503s: rate-limited wording", err?.message, RATE_LIMITED);

  if (failures > 0) {
    throw new Error(`${failures} capacity failover check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL CAPACITY FAILOVER CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
