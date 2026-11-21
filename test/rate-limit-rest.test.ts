/**
 * Regression guard for the rest that follows a per-minute pool exhaustion.
 *
 * Observed 2026-11-16: Hermes retried a exhausted pool every ~8s, and every
 * retry burned four upstream attempts (one per account) inside the same
 * saturated minute. After a transient exhaustion the tried accounts rest in
 * memory for a short while — separate from quota cooldowns and from stall
 * rests — so a retry inside that window fails fast with a retry hint instead
 * of re-saturating the shared per-minute budget.
 *
 * Stubbed throughout — no disk, network, credential or quota writes.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { PoolExhaustedError } from "../src/pool-failures";
import { GeminiWebClient, GEMINI_WEB_FALLBACK_USAGE_ID } from "../src/gemini-web-client";
import { RateLimitRests, rateRestSeconds } from "../src/rate-limit-rest";
import { StallRegistry } from "../src/upstream-stall";

const A = { email: "a@example.com", projectId: "p", refreshToken: "r" };
const B = { email: "b@example.com", projectId: "p", refreshToken: "r" };
const C = { email: "c@example.com", projectId: "p", refreshToken: "r" };

let pool: any[] = [A, B, C];
let current: any = A;
let failoverEnabled = true;
let attempts: string[] = [];
let respond: (account: any) => Response = () => ok();

(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).getValidAccessTokenForAccount = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => failoverEnabled;
(OAuthManager.prototype as any).listAccountsWithWebCookies = () => [];
(OAuthManager.prototype as any).listAccounts = () => ({ accounts: pool, activeIndex: pool.indexOf(current) });
(OAuthManager.prototype as any).selectNextAvailableAccount = (exclude?: string) => {
  const start = pool.indexOf(current);
  for (let offset = 1; offset < pool.length; offset++) {
    const candidate = pool[(start + offset) % pool.length];
    if (candidate.email === exclude || RateLimitRests.isResting(candidate.email)) continue;
    current = candidate;
    return current;
  }
  return null;
};
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).load = () => ({ perAccount: {} });
(QuotaTracker.prototype as any).save = () => {};

// A pool that runs out on reset-less 429s asks Google to count the request and then sends one
// comparison request (request-refusal.ts). Here both get the same answer as everything else, so
// the run stays a per-minute exhaustion; `attempts` counts the pool's own tries only.
(globalThis as any).fetch = async (url: unknown, init?: any) => {
  const aside = String(url).endsWith(":countTokens") || String(init?.body ?? "").includes("Reply with the single word OK.");
  if (!aside) attempts.push(current.email);
  return respond(current);
};

const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

const TRANSIENT = "Resource has been exhausted (e.g. check quota).";
const QUOTA = "Individual quota reached. Resets in 3h55m50s.";
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

function reset(responder: (account: any) => Response = () => ok(), accounts: any[] = [A, B, C]) {
  pool = accounts;
  current = accounts[0];
  failoverEnabled = true;
  attempts = [];
  respond = responder;
  RateLimitRests.clear();
}

async function runTests() {
  console.log("=================================================");
  console.log(" Rest after a transient per-minute pool exhaustion");
  console.log("=================================================\n");

  const client = new AntigravityClient();

  console.log("[1/10] A transient exhaustion rests every account it tried ...");
  reset(() => fail(429, TRANSIENT));
  let err = await caught(() => client.generateContent(payload as any));
  expect("exhausted with a retry hint", err?.retryAfterSeconds, 60);
  expect("A rests", RateLimitRests.isResting(A.email), true);
  expect("B rests", RateLimitRests.isResting(B.email), true);
  expect("C rests", RateLimitRests.isResting(C.email), true);

  console.log("\n[2/10] A retry inside the rest fails fast, without touching upstream ...");
  attempts = [];
  err = await caught(() => client.generateContent(payload as any));
  expect("no upstream attempt", attempts.length, 0);
  expect("is a PoolExhaustedError", err instanceof PoolExhaustedError, true);
  expect("carries 429", err?.status, 429);
  expect("asks for a retry later", (err?.retryAfterSeconds ?? 0) >= 1, true);
  expect("says resting", /resting/i.test(String(err?.message)), true);
  expect("names the model", String(err?.message).includes(payload.model), true);

  console.log("\n[3/10] ... on the streaming path too ...");
  attempts = [];
  err = await caught(() => client.streamGenerateContent(payload as any));
  expect("stream: no upstream attempt", attempts.length, 0);
  expect("stream: carries 429", err?.status, 429);

  console.log("\n[4/10] Once the rest ends, upstream is tried again ...");
  RateLimitRests.clear();
  reset(() => fail(429, TRANSIENT));
  err = await caught(() => client.generateContent(payload as any));
  expect("all accounts tried again", attempts.length, 3);
  expect("and rest again afterwards", RateLimitRests.isResting(A.email), true);

  console.log("\n[5/10] A 429 that wrote a cooldown rests nothing ...");
  reset(() => fail(429, QUOTA));
  err = await caught(() => client.generateContent(payload as any));
  expect("quota wording kept", /cooldown to reset/i.test(String(err?.message)), true);
  expect("A does not rest", RateLimitRests.isResting(A.email), false);
  expect("B does not rest", RateLimitRests.isResting(B.email), false);

  console.log("\n[6/10] The rate rest book and the stall rest book stay separate ...");
  reset();
  StallRegistry.rest("stall@example.com");
  RateLimitRests.rest("rate@example.com", 30);
  expect("stall rest is not a rate rest", RateLimitRests.isResting("stall@example.com"), false);
  expect("rate rest is not a stall rest", StallRegistry.isResting("rate@example.com"), false);

  console.log("\n[7/10] A resting active account is skipped for a free one ...");
  reset(() => ok());
  RateLimitRests.rest(A.email, 30);
  const res: any = await client.generateContent(payload as any);
  expect("moved to the free account", attempts[0], B.email);
  expect("request succeeded", res?.candidates?.[0]?.content?.parts?.[0]?.text, "ok");

  console.log("\n[8/10] A single resting account fails fast even with failover off ...");
  reset(() => ok(), [A]);
  failoverEnabled = false;
  RateLimitRests.rest(A.email, 30);
  err = await caught(() => client.generateContent(payload as any));
  expect("no upstream attempt", attempts.length, 0);
  expect("carries 429", err?.status, 429);
  expect("rest length default", rateRestSeconds(), 60);
  process.env.BRIDGE_RATE_REST_SECONDS = "90";
  expect("rest length from env", rateRestSeconds(), 90);
  delete process.env.BRIDGE_RATE_REST_SECONDS;

  console.log("\n[9/10] A resting pool still gets the opt-in Gemini Web fallback ...");
  reset(() => ok());
  RateLimitRests.rest(A.email, 30);
  RateLimitRests.rest(B.email, 30);
  RateLimitRests.rest(C.email, 30);
  process.env.GEMINI_WEB_FALLBACK = "1";
  (GeminiWebClient.prototype as any).hasCredentials = () => true;
  (GeminiWebClient.prototype as any).useLinkedCookies = () => {};
  (GeminiWebClient.prototype as any).generateContent = async () => ({
    candidates: [{ content: { parts: [{ text: "web answer" }] } }],
  });
  const webRes: any = await client.generateContent(payload as any);
  expect("no upstream attempt during rest", attempts.length, 0);
  expect("fallback answered", webRes?.candidates?.[0]?.content?.parts?.[0]?.text, "web answer");
  expect("usage marked for the web", webRes?.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);
  delete process.env.GEMINI_WEB_FALLBACK;

  console.log("\n[10/10] An expired rest no longer blocks upstream ...");
  reset(() => ok());
  RateLimitRests.rest(A.email, -1);
  const res2: any = await client.generateContent(payload as any);
  expect("upstream tried again", attempts[0], A.email);
  expect("request succeeded", res2?.candidates?.[0]?.content?.parts?.[0]?.text, "ok");

  if (failures > 0) {
    throw new Error(`${failures} rate-limit rest check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL RATE-LIMIT REST CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
