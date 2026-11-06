/**
 * Offline suite for Gemini Web's rotation between linked sessions.
 *
 * Verifies:
 * 1. Which failures are the account's (Google answered, uselessly) and which are not
 *    (the network, the bridge's own timeout): only the first kind may move to another session.
 * 2. generateWithLinkedSessions(): the active account first, the next linked one when it
 *    fails, the failed one rested in memory and skipped next time, at most three sessions per
 *    request inside one deadline, no rotation on a transport failure, a resting-only pool
 *    still tried, and no cookie value in the log.
 * 3. Both protocols and the CloudCode pool fallback go through it.
 *
 * No account, no network: accounts and GeminiWebClient.generateContent are stubbed.
 */

import http from "node:http";
import {
  GeminiWebClient,
  GeminiWebAccountError,
  GEMINI_WEB_FALLBACK_USAGE_ID,
} from "../src/gemini-web-client";
import { generateWithLinkedSessions, WebSessionRests, webRestSeconds, MAX_WEB_SESSIONS_PER_REQUEST } from "../src/gemini-web-rotation";
import { OAuthManager } from "../src/oauth";
import { AntigravityClient } from "../src/antigravity-client";
import { BridgeServer } from "../src/server";
import { UsageTracker } from "../src/usage-tracker";

const TEST_PORT = 52154;
let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function errorOf(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function postJson(pathUrl: string, body: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: TEST_PORT, path: pathUrl, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data: any = raw;
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const account = (email: string, cookie: string) => ({
  email,
  refreshToken: "mock",
  accessToken: "mock",
  expiresAt: Date.now() + 3_600_000,
  projectId: "p",
  webCookies: `__Secure-1PSID=${cookie}`,
});

const answer = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
});

/** Capture console output while fn runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: any; lines: string[] }> {
  const lines: string[] = [];
  const saved = { warn: console.warn, log: console.log, error: console.error };
  console.warn = (...a: any[]) => lines.push(a.join(" "));
  console.log = (...a: any[]) => lines.push(a.join(" "));
  console.error = (...a: any[]) => lines.push(a.join(" "));
  try {
    return { value: await fn(), error: null, lines };
  } catch (error) {
    return { value: null, error, lines };
  } finally {
    Object.assign(console, saved);
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" Gemini Web Session Rotation Offline Suite");
  console.log("=================================================\n");

  for (const key of ["GEMINI_WEB_COOKIES", "GEMINI_COOKIES", "GEMINI_PSID", "GEMINI_PSIDTS", "GEMINI_AUTH_USER", "GEMINI_WEB_REST_SECONDS", "GEMINI_WEB_TIMEOUT_MS"]) {
    delete process.env[key];
  }

  console.log("[1/3] Which failures are the account's ...");
  const page = '<script>{"SNlM0e":"tok-1","cfb2h":"bl-1","FdrFJe":"sid-1"}</script>';
  const classify = async (transport: (url: string) => Promise<any>) => {
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = transport;
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x", authUser: "0" });
    return errorOf(() => fresh.generateContent("hi"));
  };
  const generate429 = await classify(async (url) =>
    url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: false, status: 429, text: "slow down" }
  );
  expect("a generate that answers 429 is the account's", generate429 instanceof GeminiWebAccountError, true);
  const unreadable = await classify(async (url) =>
    url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: true, status: 200, text: ")]}'\n[]" }
  );
  expect("a 200 with no readable reply is the account's", unreadable instanceof GeminiWebAccountError, true);
  const redirected = await classify(async () => ({ ok: false, status: 302, text: "" }));
  expect("a session page that redirects (signed out) is the account's", redirected instanceof GeminiWebAccountError, true);
  expect("and still says the cookies are signed out", /signed out/.test(redirected?.message || ""), true);
  const noToken = await classify(async () => ({ ok: true, status: 200, text: "<html>no token here</html>" }));
  expect("a session page without a token is the account's", noToken instanceof GeminiWebAccountError, true);
  const refused = await classify(async () => {
    throw Object.assign(new Error(""), { code: "ECONNREFUSED" });
  });
  expect("a refused connection is not the account's", refused instanceof GeminiWebAccountError, false);
  expect("and still names its cause", /ECONNREFUSED/.test(refused?.message || ""), true);
  const timedOut = await classify(async () => {
    throw new Error("Gemini Web did not answer within 180000 ms");
  });
  expect("a timeout is not the account's", timedOut instanceof GeminiWebAccountError, false);

  console.log("\n[2/3] generateWithLinkedSessions ...");
  const client = GeminiWebClient.getInstance();
  const calls: { cookie: string; deadline: number }[] = [];
  let failing = new Set<string>();
  let transportFailing = new Set<string>();
  (client as any).generateContent = async (_prompt: any, _model?: string, deadline?: number) => {
    const cookie = String((client as any).credentials?.rawCookies || "");
    calls.push({ cookie, deadline: deadline ?? -1 });
    if (transportFailing.has(cookie)) throw new Error("Gemini Web connection failed: ECONNRESET");
    if (failing.has(cookie)) throw new GeminiWebAccountError(`Gemini Web generation failed with HTTP 429: quota`);
    return answer(`from ${cookie}`);
  };
  const A = account("a@example.com", "cookie-A-secret");
  const B = account("b@example.com", "cookie-B-secret");
  const C = account("c@example.com", "cookie-C-secret");
  const D = account("d@example.com", "cookie-D-secret");
  const reset = () => {
    calls.length = 0;
    failing = new Set();
    transportFailing = new Set();
    WebSessionRests.clear();
  };

  reset();
  const healthy = await generateWithLinkedSessions(client, [A, B], "hi");
  expect("a healthy first session answers", healthy.candidates[0].content.parts[0].text, `from ${A.webCookies}`);
  expect("and nothing else is asked", calls.length, 1);

  reset();
  failing.add(A.webCookies);
  const rotated = await captured(() => generateWithLinkedSessions(client, [A, B], "hi"));
  expect("the next linked session answers when the first fails", rotated.value?.candidates[0].content.parts[0].text, `from ${B.webCookies}`);
  expect("the failed account rests", WebSessionRests.isResting("a@example.com"), true);
  expect("the one that answered does not", WebSessionRests.isResting("b@example.com"), false);
  expect("both attempts share one deadline", calls.length === 2 && calls[0].deadline === calls[1].deadline && calls[0].deadline > 0, true);
  const rotationLine = rotated.lines.find((l) => l.includes("[Gemini Web]")) || "";
  expect("the log names both accounts", rotationLine.includes("a@example.com") && rotationLine.includes("b@example.com"), true);
  expect("and says why", rotationLine.includes("HTTP 429"), true);
  expect("and never a cookie value", rotated.lines.some((l) => l.includes("secret")), false);

  calls.length = 0;
  const skipped = await generateWithLinkedSessions(client, [A, B], "hi");
  expect("a resting account is skipped next time", calls.map((c) => c.cookie).join(","), B.webCookies);
  expect("its replacement answers", skipped.candidates[0].content.parts[0].text, `from ${B.webCookies}`);

  reset();
  transportFailing.add(A.webCookies);
  const network = await errorOf(() => generateWithLinkedSessions(client, [A, B], "hi"));
  expect("a transport failure is not rotated", calls.length, 1);
  expect("it reaches the caller as it was", /ECONNRESET/.test(network?.message || ""), true);
  expect("and rests nobody", WebSessionRests.isResting("a@example.com"), false);

  reset();
  for (const acc of [A, B, C, D]) failing.add(acc.webCookies);
  const exhausted = await captured(() => generateWithLinkedSessions(client, [A, B, C, D], "hi"));
  expect(`at most ${MAX_WEB_SESSIONS_PER_REQUEST} sessions per request`, calls.length, MAX_WEB_SESSIONS_PER_REQUEST);
  expect("the last one's failure is what fails the request", exhausted.error instanceof GeminiWebAccountError, true);
  expect("the message counts the sessions tried", /3 linked sessions/.test(exhausted.error?.message || ""), true);
  expect("and keeps Google's last answer", /HTTP 429/.test(exhausted.error?.message || ""), true);
  expect("the message carries no cookie", /secret/.test(exhausted.error?.message || ""), false);

  calls.length = 0;
  failing = new Set();
  const allResting = await generateWithLinkedSessions(client, [A, B, C], "hi");
  expect("when every session rests, they are still tried in order", calls[0]?.cookie, A.webCookies);
  expect("and one that recovered answers", allResting.candidates[0].content.parts[0].text, `from ${A.webCookies}`);
  expect("an answer ends its rest", WebSessionRests.isResting("a@example.com"), false);

  reset();
  failing.add(A.webCookies);
  const single = await errorOf(() => generateWithLinkedSessions(client, [A], "hi"));
  expect("a single session's failure is passed on unchanged", single?.message, "Gemini Web generation failed with HTTP 429: quota");

  reset();
  client.setCredentials({ rawCookies: "__Secure-1PSID=env-cookie" });
  const noLinked = await generateWithLinkedSessions(client, [], "hi");
  expect("with no linked sessions the client's own cookies answer", noLinked.candidates[0].content.parts[0].text, "from __Secure-1PSID=env-cookie");

  process.env.GEMINI_WEB_REST_SECONDS = "60";
  expect("GEMINI_WEB_REST_SECONDS sets the rest", webRestSeconds(), 60);
  process.env.GEMINI_WEB_REST_SECONDS = String(10 ** 12);
  expect("and is capped at a year", webRestSeconds(), 365 * 24 * 60 * 60);
  process.env.GEMINI_WEB_REST_SECONDS = "nonsense";
  expect("a bad value keeps the default", webRestSeconds(), 300);
  delete process.env.GEMINI_WEB_REST_SECONDS;

  console.log("\n[3/3] Both protocols and the pool fallback rotate ...");
  const oauth = OAuthManager.getInstance();
  const cloudOnly = { ...account("cloud@example.com", "x"), webCookies: undefined };
  (oauth as any).listAccounts = () => ({ accounts: [cloudOnly, A, B], activeIndex: 0 });
  (oauth as any).getValidAccessToken = async () => "mock-token";
  expect("candidates are the linked accounts, in pool order", oauth.listAccountsWithWebCookies().map((a) => a.email).join(","), "a@example.com,b@example.com");
  (oauth as any).listAccounts = () => ({ accounts: [A, B], activeIndex: 1 });
  expect("the active one comes first", oauth.listAccountsWithWebCookies().map((a) => a.email).join(","), "b@example.com,a@example.com");
  (oauth as any).listAccounts = () => ({ accounts: [A, B], activeIndex: 0 });
  (oauth as any).loadSavedAccount = () => A;
  (UsageTracker.getInstance() as any).recordUsage = () => {};

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  try {
    reset();
    failing.add(A.webCookies);
    const openai = await captured(() =>
      postJson("/v1/chat/completions", { model: "gemini-argon-4", messages: [{ role: "user", content: "hi" }] })
    );
    expect("OpenAI: answers 200 from the second session", openai.value?.status, 200);
    expect("OpenAI: with its text", openai.value?.data?.choices?.[0]?.message?.content, `from ${B.webCookies}`);

    reset();
    failing.add(A.webCookies);
    const anthropic = await captured(() =>
      postJson("/v1/messages", { model: "gemini-argon-4", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    );
    expect("Anthropic: answers 200 from the second session", anthropic.value?.status, 200);
    expect("Anthropic: with its text", anthropic.value?.data?.content?.[0]?.text, `from ${B.webCookies}`);

    reset();
    failing.add(A.webCookies);
    failing.add(B.webCookies);
    const both = await captured(() =>
      postJson("/v1/chat/completions", { model: "gemini-argon-4", messages: [{ role: "user", content: "hi" }] })
    );
    expect("every session failing is still a 500", both.value?.status, 500);
    expect("whose message counts the sessions", /2 linked sessions/.test(both.value?.data?.error?.message || ""), true);
  } finally {
    await server.stop();
  }

  reset();
  failing.add(A.webCookies);
  const antigravity = new AntigravityClient();
  (oauth as any).isAutoFailoverEnabled = () => true;
  (oauth as any).selectNextAvailableAccount = () => null;
  (antigravity as any).fetchWithRetry = async () => ({
    status: 429,
    statusText: "Too Many Requests",
    text: async () => JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }),
  });
  process.env.GEMINI_WEB_FALLBACK = "1";
  try {
    const fallback = await captured(() =>
      antigravity.generateContent({ model: "gemini-3.8-flash-tiered", request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } } as any)
    );
    expect("the pool fallback rotates too", fallback.value?.candidates?.[0]?.content?.parts?.[0]?.text, `from ${B.webCookies}`);
    expect("and is still marked as the fallback", fallback.value?.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);
  } finally {
    delete process.env.GEMINI_WEB_FALLBACK;
  }

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  }
  console.log("SUCCESS: All Gemini Web rotation assertions passed!");
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
