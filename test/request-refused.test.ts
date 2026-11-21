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
import { PoolExhaustedError, PoolFailures } from "../src/pool-failures";
import { clearVerification } from "../src/account-verification";
import { RateLimitRests } from "../src/rate-limit-rest";
import {
  COMPARISON_MAX_CHARS,
  COMPARISON_MAX_TOKENS,
  RequestRefusedError,
  comparisonRequest,
  comparisonTokens,
  countableText,
} from "../src/request-refusal";
import { BridgeServer } from "../src/server";

const A = { email: "a@example.com", projectId: "p", refreshToken: "ra" };
const B = { email: "b@example.com", projectId: "p", refreshToken: "rb" };
const C = { email: "c@example.com", projectId: "p", refreshToken: "rc" };

interface Call {
  account: string;
  /** The token count asked before the comparison. */
  count: boolean;
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
/** What Google "counts": two characters per token here, denser than any filler assumes. */
const countedFor = (body: any) => Math.ceil(String(body?.request?.contents?.[0]?.parts?.[0]?.text ?? "").length / 2);
const defaultCount = (body: any) => new Response(JSON.stringify({ totalTokens: countedFor(body) }), { status: 200 });
let respondCount: (body: any) => Response | Promise<Response> = defaultCount;

(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => `token:${current.email}`;
let tokenRefreshFails = false;
(OAuthManager.prototype as any).getValidAccessTokenForAccount = async (account: any) => {
  if (tokenRefreshFails) throw new Error("Token refresh failed (400)");
  return `token:${account.email}`;
};
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

/**
 * Three kinds of upstream call: the pool's attempts (always with a system instruction here), the
 * token count of the request, and the comparison (neither has a system instruction).
 */
(globalThis as any).fetch = async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  const count = String(url).endsWith(":countTokens");
  const comparison = !count && body.request?.systemInstruction === undefined;
  calls.push({
    account: String(init.headers.Authorization).replace("Bearer token:", ""),
    count,
    comparison,
    url: String(url),
    body,
    userAgent: String(init.headers["User-Agent"]),
  });
  if (count) return respondCount(body);
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
      generationConfig: { maxOutputTokens: 64000, thinkingConfig: { include_thoughts: true, thinking_budget: 4000 } },
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
  respondCount = defaultCount;
  RateLimitRests.clear();
}

const comparisons = () => calls.filter((c) => c.comparison);
const counts = () => calls.filter((c) => c.count);
/** The filler is two-letter words, one token per three characters; the closing question is not counted. */
const fillerTokens = (request: any) =>
  Math.floor(String(request?.contents?.[0]?.parts?.[0]?.text ?? "").replace("Reply with the single word OK.", "").length / 3);
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

  console.log("\n[3/11] The comparison: Google counts the request, then answers a neutral one of that size ...");
  reset(() => fail(429, TRANSIENT));
  await caught(() => client.generateContent(payload as any));
  const only = comparisons();
  const counted = counts();
  expect("three attempts, one count, one comparison", calls.length, 5);
  expect("the count comes after the attempts", calls[3].count, true);
  expect("the comparison comes last", calls[4].comparison, true);
  expect("exactly one count", counted.length, 1);
  expect("exactly one comparison", only.length, 1);
  expect("the count is asked of the account that answered 429 last", counted[0]?.account, C.email);
  expect("the count names the model", counted[0]?.body?.request?.model, MODEL);
  expect("the count is of the request itself", JSON.stringify(counted[0]?.body).includes("Example Agent"), true);
  expect("the count presents the Antigravity client", counted[0]?.userAgent.startsWith("antigravity/"), true);
  expect("the comparison is asked of the same account", only[0]?.account, C.email);
  expect("to the same model", only[0]?.body?.model, MODEL);
  expect("streaming, so the status is known before the answer", only[0]?.url.endsWith("/v1internal:streamGenerateContent?alt=sse"), true);
  expect("carries no tools", only[0]?.body?.request?.tools, undefined);
  expect(
    "carries the request's own generation settings",
    JSON.stringify(only[0]?.body?.request?.generationConfig),
    JSON.stringify(payload.request.generationConfig)
  );
  expect("presents the Antigravity client", only[0]?.userAgent.startsWith("antigravity/"), true);
  // The count is of the request as text. Google counted a real request with 20 tools 3.7% above
  // its text (2026-11-21), so the comparison is a quarter larger than the count.
  const wanted = Math.ceil(countedFor(counted[0]?.body) * 1.25);
  const sent = fillerTokens(only[0]?.body?.request);
  expect("is a quarter more tokens than Google counted, never fewer", sent >= wanted, true);
  expect("and not many more", sent < wanted + 8, true);
  expect("the margin is applied to the count", comparisonTokens(8000, 0), 10000);
  expect("an inline part adds a flat allowance", comparisonTokens(8000, 2), 12000);
  expect("carries none of the request's text", JSON.stringify(only[0]?.body).includes("Example Agent"), false);

  // Inline data is base64: its length says nothing about its tokens, and it is megabytes to send twice.
  const image = payloadWith("hi");
  (image.request.contents[0].parts as any[]).unshift({ inlineData: { mimeType: "image/png", data: "QUJD".repeat(500_000) } });
  const countable = countableText(image.request);
  expect("inline data is left out of what is counted", countable.text.includes("QUJDQUJD"), false);
  expect("and remembered as one inline part", countable.inlineParts, 1);
  reset(() => fail(429, TRANSIENT));
  await caught(() => client.generateContent(image as any));
  expect("a request with a large image is still compared", comparisons().length, 1);
  expect("the count carries no base64", JSON.stringify(counts()[0]?.body).includes("QUJDQUJD"), false);
  expect(
    "the image gets an allowance on top of the count",
    fillerTokens(comparisons()[0]?.body?.request) >= Math.ceil(countedFor(counts()[0]?.body) * 1.25) + 1000,
    true
  );
  const plain = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  expect("filler for 1000 tokens is 1000 tokens", fillerTokens(comparisonRequest(1000, plain)), 1000);
  expect("no generation settings are invented", "generationConfig" in comparisonRequest(1000, plain), false);

  // Only the status matters: the stream is dropped as soon as it opens, however long the answer runs.
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        },
      }),
      { status: 200 }
    );
  reset(() => fail(429, TRANSIENT), endless);
  const before = Date.now();
  err = await caught(() => client.generateContent(payload as any));
  expect("an answer that never ends is still an answer", err instanceof RequestRefusedError, true);
  expect("decided at once", Date.now() - before < 1000, true);
  expect("without reading it through", pulled < 5, true);

  console.log("\n[4/11] The comparison is rate limited too: a per-minute limit, as before ...");
  reset(() => fail(429, TRANSIENT), () => fail(429, TRANSIENT));
  err = await caught(() => client.generateContent(payload as any));
  expect("is a PoolExhaustedError", err instanceof PoolExhaustedError, true);
  expect("retry hint", err?.retryAfterSeconds, 60);
  expect("says per-minute", String(err?.message).includes("per-minute rate limit"), true);
  expect("every account rests", resting(), 3);
  expect("the comparison was asked once", comparisons().length, 1);

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

  reset(() => fail(429, TRANSIENT));
  tokenRefreshFails = true;
  err = await caught(() => client.generateContent(payload as any));
  tokenRefreshFails = false;
  expect("a token that cannot be refreshed: still a per-minute exhaustion", err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);
  expect("a token that cannot be refreshed: nothing was asked", comparisons().length, 0);

  // Without a count the comparison's size cannot be vouched for, so none is sent.
  const uncounted: Array<[string, (body: any) => Response | Promise<Response>]> = [
    ["a count Google refuses", () => fail(500, "Internal error")],
    ["a count with no total", () => new Response("{}", { status: 200 })],
    ["a count that cannot connect", () => Promise.reject(new TypeError("fetch failed"))],
  ];
  for (const [label, responder] of uncounted) {
    reset(() => fail(429, TRANSIENT));
    respondCount = responder;
    err = await caught(() => client.generateContent(payload as any));
    expect(`${label}: still a per-minute exhaustion`, err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);
    expect(`${label}: no comparison`, comparisons().length, 0);
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

  reset(() => fail(429, TRANSIENT));
  respondCount = () => new Response(JSON.stringify({ totalTokens: COMPARISON_MAX_TOKENS }), { status: 200 });
  err = await caught(() => client.generateContent(payload as any));
  expect("a request counted past the token cap: no comparison", comparisons().length, 0);
  expect("a request counted past the token cap: per-minute, as before", err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);

  const huge = payloadWith("x".repeat(COMPARISON_MAX_CHARS + 1));
  reset(() => fail(429, TRANSIENT));
  err = await caught(() => client.generateContent(huge as any));
  expect("a request too long to count: not even counted", counts().length, 0);
  expect("a request too long to count: no comparison", comparisons().length, 0);
  expect("a request too long to count: per-minute, as before", err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);

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

  // Seen on the VPS on 2026-11-21, on the first request after a restart: three accounts answered
  // 429 and the run ended on the one Google wants verified (403). Only the last attempt was read,
  // so the 429s were dropped and the client got a 500 naming a cooldown nobody recorded.
  const lastRefused = () => (current === C ? fail(403, "Verify your account to continue.") : fail(429, TRANSIENT));
  reset(lastRefused);
  err = await caught(() => client.generateContent(payload as any));
  clearVerification(C.email);
  expect("a run ending on a refused account: still a refused request", err instanceof RequestRefusedError, true);
  expect("it counts the accounts that answered 429", String(err?.message).includes("2 of 3 accounts tried"), true);
  expect("the comparison goes to the last account that answered 429", comparisons()[0]?.account, B.email);
  reset(lastRefused, () => fail(429, TRANSIENT));
  err = await caught(() => client.streamGenerateContent(payload as any));
  clearVerification(C.email);
  expect("with a rate limited comparison: a per-minute exhaustion, not a 500", err instanceof PoolExhaustedError && err.retryAfterSeconds === 60, true);
  const blank = { hit429: false, hit503: false, message503: "", stalled: false };
  const mixed = new PoolFailures();
  mixed.record("a", { ...blank, hit503: true, message503: "No capacity available for model x on the server" });
  mixed.record("b", { ...blank, hit403: true });
  expect("a 503 before the refused account is still no capacity", (mixed.exhaustedError("m") as any)?.kind, "capacity");
  expect("and the pool still ran out", mixed.ranOut(), true);
  const onlyRefused = new PoolFailures();
  onlyRefused.record("b", { ...blank, hit403: true });
  expect("only refused accounts: the 403 itself is the answer", onlyRefused.exhaustedError("m"), null);
  expect("and that is not the pool running out", onlyRefused.ranOut(), false);
  const otherLast = new PoolFailures();
  otherLast.record("a", { ...blank, hit429: true });
  otherLast.record("b", blank);
  expect("a run ending on some other failure keeps that failure", otherLast.exhaustedError("m"), null);

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
