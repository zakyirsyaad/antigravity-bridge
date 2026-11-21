/**
 * Regression guard for a request Google refuses by its content while answering it as a 429.
 *
 * Observed 2026-11-21: every request from Hermes Agent came back HTTP 429 "Resource has been
 * exhausted (e.g. check quota)." on all three accounts, on Gemini and Claude alike, in under a
 * second, with the quota meters at 100%. Asked directly, Google answered 429 to any request whose
 * system instruction said "You are Hermes Agent," and 200 to the same request without it. The
 * bridge called it a per-minute rate limit ("wait about 60s, or send a smaller request"), so the
 * client retried six times, and rested the whole pool for a minute each time, which failed every
 * other client's requests too.
 *
 * A 429 from a real per-minute limit and a refusal look the same, so the pool asks once more: a
 * neutral request of the same size, to the same model, on an account that just answered 429. If
 * that is answered, the accounts are not rate limited and the size is not the reason: the request
 * is refused, nobody rests, and the client is told retrying will not help. Anything else keeps
 * the per-minute behaviour.
 *
 * Stubbed throughout: no disk, network, credential or quota writes.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { PoolExhaustedError } from "../src/pool-failures";
import { RateLimitRests } from "../src/rate-limit-rest";
import { COMPARISON_MAX_CHARS, RequestRefusedError } from "../src/request-refusal";
import { BridgeServer } from "../src/server";

const A = { email: "a@example.com", projectId: "p", refreshToken: "ra" };
const B = { email: "b@example.com", projectId: "p", refreshToken: "rb" };
const C = { email: "c@example.com", projectId: "p", refreshToken: "rc" };

interface Call {
  account: string;
  comparison: boolean;
  url: string;
  body: any;
  userAgent: string;
}

let pool: any[] = [A, B, C];
let current: any = A;
let calls: Call[] = [];
let respond: () => Response | Promise<Response> = () => ok();
let respondComparison: (init: any) => Response | Promise<Response> = () => ok();

(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => `token:${current.email}`;
(OAuthManager.prototype as any).getValidAccessTokenForAccount = async (account: any) => `token:${account.email}`;
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => true;
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

// The suite's own HTTP calls to the bridge must bypass the upstream fetch stub.
const realFetch = globalThis.fetch;

/** The request under test always carries a system instruction; the comparison never does. */
(globalThis as any).fetch = async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  const comparison = body.request?.systemInstruction === undefined;
  calls.push({
    account: String(init.headers.Authorization).replace("Bearer token:", ""),
    comparison,
    url: String(url),
    body,
    userAgent: String(init.headers["User-Agent"]),
  });
  return comparison ? respondComparison(init) : respond();
};

const ok = () =>
  new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }), { status: 200 });
const fail = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

const TRANSIENT = "Resource has been exhausted (e.g. check quota).";
const QUOTA = "Individual quota reached. Resets in 3h55m50s.";
const MODEL = "gemini-3.8-flash-tiered";

function payloadWith(userText: string) {
  return {
    model: MODEL,
    request: {
      systemInstruction: { parts: [{ text: "You are Example Agent, a third-party harness." }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      tools: [{ functionDeclarations: [{ name: "read_file", description: "Read a file", parameters: { type: "OBJECT" } }] }],
    },
  };
}
const payload = payloadWith("hi ".repeat(2000));

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

function reset(
  responder: () => Response | Promise<Response>,
  comparisonResponder: (init: any) => Response | Promise<Response> = () => ok(),
  accounts: any[] = [A, B, C]
) {
  pool = accounts;
  current = accounts[0];
  calls = [];
  respond = responder;
  respondComparison = comparisonResponder;
  RateLimitRests.clear();
}

const comparisons = () => calls.filter((c) => c.comparison);
const resting = () => pool.filter((a) => RateLimitRests.isResting(a.email)).length;

async function runTests() {
  console.log("=================================================");
  console.log(" A request Google refuses while answering 429");
  console.log("=================================================\n");

  const client = new AntigravityClient();

  console.log("[1/11] Every account answers 429, the comparison is answered: the request is refused ...");
  reset(() => fail(429, TRANSIENT));
  let err = await caught(() => client.generateContent(payload as any));
  expect("is a RequestRefusedError", err instanceof RequestRefusedError, true);
  expect("is not a pool exhaustion", err instanceof PoolExhaustedError, false);
  expect("carries no Google status", err?.status, undefined);
  expect("asks for no retry", err?.retryAfterSeconds, undefined);
  expect("no account rests", resting(), 0);
  expect("names the model", String(err?.message).includes(MODEL), true);
  expect("counts the accounts", String(err?.message).includes("all 3 accounts tried"), true);
  expect("says it is not a rate limit", /not a rate limit/i.test(String(err?.message)), true);
  expect("says retrying will not help", /retrying .*will not help/i.test(String(err?.message)), true);
  expect("keeps Google's message", String(err?.message).includes(TRANSIENT), true);
  expect("names no account", /@example\.com/.test(String(err?.message)), false);

  console.log("\n[2/11] The next request is asked upstream again, not failed fast ...");
  calls = [];
  respond = () => ok();
  const answer: any = await client.generateContent(payload as any);
  expect("reached upstream", calls.length, 1);
  expect("answered", answer?.response?.candidates?.[0]?.content?.parts?.[0]?.text, "ok");

  console.log("\n[3/11] The comparison: one neutral request of the same size, same model, same account ...");
  reset(() => fail(429, TRANSIENT));
  await caught(() => client.generateContent(payload as any));
  const only = comparisons();
  expect("three attempts and one comparison", calls.length, 4);
  expect("exactly one comparison", only.length, 1);
  expect("after the attempts", calls[3].comparison, true);
  expect("on an account that answered 429", only[0]?.account, C.email);
  expect("to the same model", only[0]?.body?.model, MODEL);
  expect("non-streaming", only[0]?.url.endsWith("/v1internal:generateContent"), true);
  expect("carries no tools", only[0]?.body?.request?.tools, undefined);
  expect("asks for a short answer", (only[0]?.body?.request?.generationConfig?.maxOutputTokens ?? 1e9) <= 64, true);
  expect("presents the Antigravity client", only[0]?.userAgent.startsWith("antigravity/"), true);
  const original = JSON.stringify(payload.request).length;
  const compared = JSON.stringify(only[0]?.body?.request ?? {}).length;
  expect("is about as large as the request", Math.abs(compared - original) / original < 0.1, true);
  expect("carries none of the request's text", JSON.stringify(only[0]?.body).includes("Example Agent"), false);

  console.log("\n[4/11] The comparison is rate limited too: a per-minute limit, as before ...");
  reset(() => fail(429, TRANSIENT), () => fail(429, TRANSIENT));
  err = await caught(() => client.generateContent(payload as any));
  expect("is a PoolExhaustedError", err instanceof PoolExhaustedError, true);
  expect("retry hint", err?.retryAfterSeconds, 60);
  expect("says per-minute", String(err?.message).includes("per-minute rate limit"), true);
  expect("every account rests", resting(), 3);

  console.log("\n[5/11] A comparison that proves nothing changes nothing ...");
  const inconclusive: Array<[string, (init: any) => Response | Promise<Response>]> = [
    ["a 503", () => fail(503, "No capacity available for model x on the server")],
    ["a 403", () => fail(403, "Verify your account to continue.")],
    ["a 400", () => fail(400, "Request contains an invalid argument.")],
    ["a refused connection", () => Promise.reject(new TypeError("fetch failed"))],
  ];
  for (const [label, responder] of inconclusive) {
    reset(() => fail(429, TRANSIENT), responder);
    err = await caught(() => client.generateContent(payload as any));
    expect(`${label}: still a per-minute exhaustion`, err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);
    expect(`${label}: every account rests`, resting(), 3);
  }

  console.log("\n[6/11] A comparison Google never answers is given up on ...");
  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "150";
  reset(
    () => fail(429, TRANSIENT),
    (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  );
  // AbortSignal.timeout() does not hold the event loop open, and here nothing else does:
  // without this timer Node exits 0 mid-suite, which reads as a pass.
  const keepAlive = setTimeout(() => {}, 10_000);
  const started = Date.now();
  err = await caught(() => client.generateContent(payload as any));
  clearTimeout(keepAlive);
  delete process.env.BRIDGE_UPSTREAM_TIMEOUT_MS;
  expect("still a per-minute exhaustion", err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);
  expect("within the timeout", Date.now() - started < 2000, true);

  console.log("\n[7/11] No comparison when the 429 is not a reset-less one, or nothing could be learned ...");
  reset(() => fail(429, QUOTA));
  err = await caught(() => client.generateContent(payload as any));
  expect("a quota window: no comparison", comparisons().length, 0);
  expect("a quota window: not refused", err instanceof RequestRefusedError, false);

  reset(() => fail(503, "No capacity available for model x on the server"));
  err = await caught(() => client.generateContent(payload as any));
  expect("no capacity: no comparison", comparisons().length, 0);
  expect("no capacity: still capacity", err?.kind, "capacity");

  const huge = payloadWith("x".repeat(COMPARISON_MAX_CHARS + 1));
  reset(() => fail(429, TRANSIENT));
  err = await caught(() => client.generateContent(huge as any));
  expect("a request past the size cap: no comparison", comparisons().length, 0);
  expect("a request past the size cap: per-minute, as before", err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);

  calls = [];
  err = await caught(() => client.generateContent(payload as any));
  expect("a resting pool: nothing is asked", calls.length, 0);
  expect("a resting pool: fails fast", /resting/i.test(String(err?.message)), true);

  console.log("\n[8/11] One account, no pool to rotate ...");
  reset(() => fail(429, TRANSIENT), () => ok(), [A]);
  err = await caught(() => client.generateContent(payload as any));
  expect("is refused", err instanceof RequestRefusedError, true);
  expect("says the account tried", String(err?.message).includes("the account tried"), true);
  expect("the account does not rest", resting(), 0);

  console.log("\n[9/11] The streaming path decides the same way ...");
  reset(() => fail(429, TRANSIENT));
  err = await caught(() => client.streamGenerateContent(payload as any));
  expect("stream: is refused", err instanceof RequestRefusedError, true);
  expect("stream: one comparison", comparisons().length, 1);
  expect("stream: no account rests", resting(), 0);
  reset(() => fail(429, TRANSIENT), () => fail(429, TRANSIENT));
  err = await caught(() => client.streamGenerateContent(payload as any));
  expect("stream: a rate limited comparison rests the pool", resting(), 3);

  console.log("\n[10/11] The wire answers 400 invalid_request_error, with no Retry-After, on all four paths ...");
  const server = new BridgeServer(52157);
  await server.start();
  try {
    const system = "You are Example Agent, a third-party harness.";
    const routes: Array<[string, string, any]> = [
      ["openai non-stream", "/v1/chat/completions", { messages: [{ role: "system", content: system }, { role: "user", content: "hi" }] }],
      ["openai stream", "/v1/chat/completions", { stream: true, messages: [{ role: "system", content: system }, { role: "user", content: "hi" }] }],
      ["anthropic non-stream", "/v1/messages", { max_tokens: 64, system, messages: [{ role: "user", content: "hi" }] }],
      ["anthropic stream", "/v1/messages", { max_tokens: 64, stream: true, system, messages: [{ role: "user", content: "hi" }] }],
    ];
    for (const [label, route, extra] of routes) {
      reset(() => fail(429, TRANSIENT));
      const res = await realFetch(`http://127.0.0.1:52157${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, ...extra }),
      });
      const body: any = await res.json().catch(() => null);
      expect(`${label}: status`, res.status, 400);
      expect(`${label}: no Retry-After`, res.headers.get("retry-after"), null);
      expect(`${label}: error type`, body?.error?.type, "invalid_request_error");
      expect(`${label}: says it is not a rate limit`, /not a rate limit/i.test(String(body?.error?.message)), true);
      expect(`${label}: no account rests`, resting(), 0);
    }

    console.log("\n[11/11] ... and a real per-minute limit is still a 429 with Retry-After ...");
    reset(() => fail(429, TRANSIENT), () => fail(429, TRANSIENT));
    const res = await realFetch("http://127.0.0.1:52157/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: "hi" }] }),
    });
    expect("status", res.status, 429);
    expect("Retry-After", res.headers.get("retry-after"), "60");
    await res.text();
  } finally {
    await server.stop();
  }

  if (failures > 0) {
    throw new Error(`${failures} refused-request check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL REFUSED-REQUEST CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
