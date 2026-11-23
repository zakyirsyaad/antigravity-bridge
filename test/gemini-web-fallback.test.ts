/**
 * Offline test suite for Gemini Web Client & Failover Fallback.
 *
 * Verifies:
 * 1. SNlM0e session parameter extraction from HTML.
 * 2. Cookie header formation from discrete __Secure-1PSID / __Secure-1PSIDTS or raw string.
 * 3. Double-JSON RPC payload formatting (f.req array structure).
 * 4. Anti-XSSI prefixed response stream extraction ()]}'\n...).
 * 5. Model ids, prompt text (system instruction, tool calls and results), session handling.
 * 6. AntigravityClient's opt-in fallback to Gemini Web when the CloudCode pool runs out.
 * 7. Model resolution and webRequest (header room, redirects, timeouts, error causes).
 */

import http from "node:http";
import { GeminiWebAccountError, GeminiWebClient, GEMINI_WEB_FALLBACK_USAGE_ID, webRequest, webTimeoutMs } from "../src/gemini-web-client";
import { parseToolBridgeOutput } from "../src/tool-bridge";
import { Transformer } from "../src/transformer";
import { AntigravityClient } from "../src/antigravity-client";
import { RateLimitRests } from "../src/rate-limit-rest";
import { OAuthManager } from "../src/oauth";
import { SIGNED_IN_PAGE } from "./gemini-web-fixtures";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" Gemini Web Fallback Offline Suite");
  console.log("=================================================\n");

  const client = GeminiWebClient.getInstance();

  console.log("[1/7] Extracting session parameters from HTML ...");
  const mockHtml = `
    <html>
      <script>
        var WIZ_global_data = {
          "SNlM0e": "AIzaMockSessionToken123XYZ",
          "cfb2h": "boq_assistant-bard-web-server_20261105.01_p0",
          "FdrFJe": "987654321012345678"
        };
      </script>
    </html>
  `;
  const session = GeminiWebClient.extractSessionParameters(mockHtml, "__Secure-1PSID=mock-psid");
  expect("extracts SNlM0e session token", session.at, "AIzaMockSessionToken123XYZ");
  expect("extracts cfb2h build label", session.bl, "boq_assistant-bard-web-server_20261105.01_p0");
  expect("extracts FdrFJe session ID", session.fsid, "987654321012345678");

  console.log("\n[2/7] Building Cookie headers ...");
  client.setCredentials({
    psid: "test-psid-val",
    psidts: "test-psidts-val",
  });
  expect(
    "builds cookie header from pair",
    client.buildCookieHeader(),
    "__Secure-1PSID=test-psid-val; __Secure-1PSIDTS=test-psidts-val"
  );

  client.setCredentials({
    rawCookies: "SID=session-123; __Secure-1PSID=raw-psid",
  });
  expect("uses filtered essential rawCookies when provided", client.buildCookieHeader(), "SID=session-123; __Secure-1PSID=raw-psid");
  // Without gemini.google.com's own session cookies the page redirects to ServiceLogin,
  // and signed-in cookies read as signed out: they must survive the filter.
  client.setCredentials({
    rawCookies: "NID=big; __Secure-1PSID=p; OSID=o; COMPASS=big; __Secure-OSID=so",
  });
  expect("keeps OSID and __Secure-OSID, still drops tracking cookies", client.buildCookieHeader(), "__Secure-1PSID=p; OSID=o; __Secure-OSID=so");
  {
    // The environment's separate values need their OSID too, or that path stays signed out.
    const saved = { a: process.env.GEMINI_WEB_COOKIES, b: process.env.GEMINI_COOKIES, c: process.env.GEMINI_PSID, d: process.env.GEMINI_PSIDTS, e: process.env.GEMINI_OSID };
    delete process.env.GEMINI_WEB_COOKIES;
    delete process.env.GEMINI_COOKIES;
    process.env.GEMINI_PSID = "p";
    process.env.GEMINI_PSIDTS = "ts";
    process.env.GEMINI_OSID = "so";
    const envClient: GeminiWebClient = new (GeminiWebClient as any)();
    (envClient as any).loadCredentialsFromEnv();
    expect("GEMINI_OSID joins the environment's cookies", envClient.buildCookieHeader(), "__Secure-1PSID=p; __Secure-1PSIDTS=ts; __Secure-OSID=so");
    for (const [k, v] of Object.entries({ GEMINI_WEB_COOKIES: saved.a, GEMINI_COOKIES: saved.b, GEMINI_PSID: saved.c, GEMINI_PSIDTS: saved.d, GEMINI_OSID: saved.e })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log("\n[3/7] RPC payload double-JSON formatting ...");
  const rpcBody = GeminiWebClient.buildRpcPayload("Hello Gemini Web", "AIzaToken123");
  expect("at param matches token", rpcBody.get("at"), "AIzaToken123");
  const fReqRaw = rpcBody.get("f.req");
  expect("f.req exists", Boolean(fReqRaw), true);
  const outerJson = JSON.parse(fReqRaw || "[]");
  expect("outer json is array of two", Array.isArray(outerJson) && outerJson.length === 2, true);
  const innerJson = JSON.parse(outerJson[1]);
  expect("inner json prompt at index 0", innerJson[0][0], "Hello Gemini Web");

  console.log("\n[4/7] Anti-XSSI response unmarshaling ...");
  const mockAntiXssiResp = `)]}'
342
[["wrb.fr",null,"[[null,null,\\"c_123\\"],null,null,null,[[[\\"rc_abc\\",[\\"Halo! Ada yang bisa saya bantu?\\"]]]]]"]]
`;
  const parsedResp = GeminiWebClient.parseAntiXssiResponse(mockAntiXssiResp);
  const textOutput = parsedResp.candidates?.[0]?.content?.parts?.[0]?.text;
  expect("extracts candidate text cleanly", textOutput, "Halo! Ada yang bisa saya bantu?");
  expect("an answer carries no error", parsedResp.webError, undefined);
  // The shape Gemini Web answered a Neon request with on 2026-11-24.
  const refusal = ")]}'\n\n174\n" + JSON.stringify([["wrb.fr", null, null, null, null, [13, null, [["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo", [1155, null, "Too many requests. Try again later. (1155)"]]]]]]) + "\n25\n[[\"e\",4,null,null,271]]\n";
  const untyped = ")]}'\n\n" + JSON.stringify([["wrb.fr", null, null, null, null, [13, null, [["type.googleapis.com/some.OtherInfo", [7, null, "not ours"]]]]]]);
  expect("only a detail typed BardErrorInfo is read as Google's code", GeminiWebClient.parseAntiXssiResponse(untyped).webError, undefined);
  expect("a refusal is read as an error with its code", JSON.stringify(GeminiWebClient.parseAntiXssiResponse(refusal).webError), JSON.stringify({ code: 1155, message: "Too many requests. Try again later. (1155)" }));

  console.log("\n[5/7] Model ids, prompt text, and session handling ...");
  expect("neon resolves to Gemini Web's id", GeminiWebClient.resolveWebModelId("gemini-neon-4"), "e6fa609c3fa255c0");
  expect("carbon resolves to Gemini Web's id", GeminiWebClient.resolveWebModelId("gemini-carbon-4"), "95a4c0abcba24364");
  expect("neon and carbon are web models", ["gemini-neon-4", "neon", "gemini-carbon-4", "carbon"].every((m) => GeminiWebClient.isGeminiWebModel(m)), true);
  expect("argon is gone: no longer a web model", GeminiWebClient.isGeminiWebModel("gemini-argon-4"), false);
  expect("but its recorded usage is still labelled Gemini Web", GeminiWebClient.wasGeminiWebModel("gemini-argon-4"), true);
  expect("and a CloudCode id is not", GeminiWebClient.wasGeminiWebModel("gemini-3.8-flash-tiered"), false);
  expect("the gemini-4-* spelling is a web model too", ["gemini-4-neon", "gemini-4-carbon", "openrouter/gemini-4-neon"].every((m) => GeminiWebClient.isGeminiWebModel(m)), true);
  expect("gemini-4-neon resolves to Neon", GeminiWebClient.resolveWebModelId("gemini-4-neon"), "e6fa609c3fa255c0");
  expect("gemini-4-carbon resolves to Carbon", GeminiWebClient.resolveWebModelId("gemini-4-carbon"), "95a4c0abcba24364");
  expect("Hydrogen is not a web model (it is served from CloudCode)", GeminiWebClient.isGeminiWebModel("gemini-4-hydrogen-sonar"), false);
  expect("neon is selected by the header the page sends", GeminiWebClient.modelSelectionHeader("gemini-neon-4"), '[1,null,null,null,"e6fa609c3fa255c0",null,null,0,[4],null,null,2]');
  expect("gemini-auto sends no selection header", GeminiWebClient.modelSelectionHeader("gemini-auto"), null);
  expect("a bridge name is never sent as a model id", GeminiWebClient.resolveWebModelId("gemini-advanced"), null);
  expect("a provider prefix is dropped", GeminiWebClient.isGeminiWebModel("open-design-byok/gemini-auto"), true);
  expect("an unrelated id is not a web model", GeminiWebClient.isGeminiWebModel("gemini-3.8-flash-tiered"), false);
  const rpcBodyInner = JSON.parse(JSON.parse(GeminiWebClient.buildRpcPayload("hi", "tok").get("f.req")!)[1]);
  expect("the body no longer carries a model id at index 79", rpcBodyInner[79], null);
  const promptText = GeminiWebClient.requestToPromptText({
    systemInstruction: { parts: [{ text: "Be terse." }] },
    contents: [
      { role: "user", parts: [{ text: "weather?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Berlin" } } }] },
    ],
  });
  expect("system instruction is in the prompt", promptText.startsWith("System: Be terse."), true);
  // In the JSON shape the bridge asks the model to answer in, so a reply in the history's
  // own style is still a tool call the bridge can read.
  expect("a prior tool call is in the prompt", promptText.includes('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Berlin"}}]}'), true);
  const echoed = parseToolBridgeOutput('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Berlin"}}]}');
  expect("the history's call shape parses back as a tool call", echoed.finish_reason, "tool_calls");
  const parallel = GeminiWebClient.requestToPromptText({
    contents: [
      { role: "user", parts: [{ text: "read both" }] },
      {
        role: "model",
        parts: [
          { functionCall: { id: "toolu_1", name: "Read", args: { path: "a.txt" } } },
          { functionCall: { id: "toolu_2", name: "Read", args: { path: "b.txt" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "toolu_2", name: "Read", response: { content: "BBB" } } },
          { functionResponse: { id: "toolu_1", name: "Read", response: { content: "" } } },
        ],
      },
    ],
  });
  expect("a result names its call (parallel results arrive in any order)", parallel.includes("[Tool Result (Read, id toolu_2): BBB]"), true);
  expect("an empty result is still shown, not dropped", parallel.includes("[Tool Result (Read, id toolu_1): (empty)]"), true);
  expect("calls carry the id their results name", parallel.includes('"id":"toolu_1"'), true);

  const errorOf = async (run: () => Promise<any>): Promise<any> => {
    try {
      await run();
      return null;
    } catch (err) {
      return err;
    }
  };
  const fetched: string[] = [];
  // A signed-in page: a signed-out visitor's page has a token too, but no signed-in marker.
  const page = SIGNED_IN_PAGE;
  const stubTransport = async (url: string) => {
    fetched.push(url);
    if (url.endsWith("/app")) {
      // The root page fails; the second signed-in account's page works.
      return url === "https://gemini.google.com/u/1/app"
        ? { ok: true, status: 200, text: page }
        : { ok: false, status: 500, text: "nope" };
    }
    return { ok: false, status: 401, text: "expired" };
  };
  {
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = stubTransport;
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    let threw = false;
    try {
      await fresh.generateContent("hi");
    } catch {
      threw = true;
    }
    expect("a 401 from generate throws", threw, true);
    const generateUrl = fetched.find((u) => u.includes("StreamGenerate")) || "";
    expect("generate posts to the account the session came from", generateUrl.startsWith("https://gemini.google.com/u/1/_/"), true);
    expect("a failed generate drops the cached session", (fresh as any).session, null);
  }
  {
    // Gemini Web reports no token counts: the answer carries an estimate in Google's shape.
    const answerText = "Hello there, this is Neon.";
    const xssi = ")]}'\n\n" + JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [["rc_1", [answerText]]]])]]);
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    let generateHeaders: Record<string, string> = {};
    (fresh as any).transport = async (url: string, init: any) => {
      if (url.endsWith("/app")) return { ok: true, status: 200, text: page };
      generateHeaders = init.headers;
      return { ok: true, status: 200, text: xssi };
    };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    const prompt = "x".repeat(4001);
    const resp = await fresh.generateContent(prompt, "gemini-neon-4");
    expect("the answer text is parsed", resp.candidates[0].content.parts[0].text, answerText);
    expect("generate selects Neon with the header", generateHeaders["x-goog-ext-525001261-jspb"], GeminiWebClient.modelSelectionHeader("gemini-neon-4"));
    expect("prompt tokens are estimated from the prompt sent", resp.usageMetadata?.promptTokenCount, 1001);
    expect("answer tokens are estimated from the answer", resp.usageMetadata?.candidatesTokenCount, Math.ceil(answerText.length / 4));
    expect("total is their sum", resp.usageMetadata?.totalTokenCount, 1001 + Math.ceil(answerText.length / 4));
  }
  {
    // A 200 with nothing readable must not reach a client as an empty success.
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) =>
      url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: true, status: 200, text: ")]}'\n\n[]" };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    let emptyErr: any = null;
    try {
      await fresh.generateContent("hi");
    } catch (err) {
      emptyErr = err;
    }
    expect("an answer with no readable reply throws", /no readable reply/.test(String(emptyErr?.message)), true);
    expect("and drops the cached session", (fresh as any).session, null);
  }
  {
    // A refusal says what Gemini Web said, and rotates like any account failure.
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) =>
      url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: true, status: 200, text: refusal };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    let refusedErr: any = null;
    try {
      await fresh.generateContent("hi", "gemini-neon-4");
    } catch (err) {
      refusedErr = err;
    }
    expect("a refusal names Gemini Web's reason", String(refusedErr?.message), "Gemini Web refused the request (code 1155): Too many requests. Try again later. (1155)");
    expect("and is an account error, so the rotation moves on", refusedErr instanceof GeminiWebAccountError, true);
  }
  {
    // A payload with no candidate: its strings are metadata (the response id), never the answer.
    const noCandidate = ")]}'\n\n" + JSON.stringify([["wrb.fr", null, JSON.stringify([null, ["c_1", "r_9f8e7d"], null, null])]]);
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) =>
      url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: true, status: 200, text: noCandidate };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    const idErr = await errorOf(() => fresh.generateContent("hi"));
    expect("a reply with no candidate is unreadable, not the response id", /no readable reply/.test(String(idErr?.message)), true);
  }
  {
    // An explicit account choice pins the session: no silent switch to another account.
    const pinnedFetches: string[] = [];
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) => {
      pinnedFetches.push(url);
      return { ok: false, status: 503, text: "busy" };
    };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x", authUser: "2" });
    const pinnedErr = await errorOf(() => fresh.generateContent("hi"));
    expect("a configured account is the only page tried", pinnedFetches.join(","), "https://gemini.google.com/u/2/app");
    expect("the error names the configured page", String(pinnedErr?.message).includes("/u/2/app answered HTTP 503"), true);
  }
  {
    // Without a choice, a session from the second account is short-lived, so the default is retried.
    const xssi = ")]}'\n\n" + JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [["rc_1", ["ok"]]]])]]);
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) => {
      if (url === "https://gemini.google.com/app") return { ok: false, status: 500, text: "nope" };
      return url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: true, status: 200, text: xssi };
    };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    await fresh.generateContent("hi");
    const ttl = ((fresh as any).session?.expiresAt ?? 0) - Date.now();
    expect("a session from another account expires within 10 minutes", ttl > 0 && ttl <= 10 * 60 * 1000, true);
  }
  {
    // Signed-out cookies: every page redirects; the error says so, about the page that was asked.
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async () => ({ ok: false, status: 302, text: "" });
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    const outErr = await errorOf(() => fresh.generateContent("hi"));
    expect("a redirect says the cookies are signed out", /\/app redirected \(HTTP 302\).*signed out/.test(String(outErr?.message)), true);
    expect("and names __Secure-OSID, the usual reason now", String(outErr?.message).includes("__Secure-OSID"), true);
  }
  {
    // GEMINI_WEB_TIMEOUT_MS is one budget for the whole request, pages and generate together.
    process.env.GEMINI_WEB_TIMEOUT_MS = "1000";
    const budgets: number[] = [];
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (_url: string, init: any) => {
      budgets.push(init.timeoutMs);
      await new Promise((r) => setTimeout(r, 400));
      return { ok: false, status: 500, text: "nope" };
    };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    await errorOf(() => fresh.generateContent("hi"));
    delete process.env.GEMINI_WEB_TIMEOUT_MS;
    expect("each later call gets only what is left of the budget", budgets.length === 2 && budgets[1] <= 650 && budgets[1] > 0, true);
  }
  {
    // Linked cookies keep the operator's account choice.
    process.env.GEMINI_AUTH_USER = "1";
    const linkedFetches: string[] = [];
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) => {
      linkedFetches.push(url);
      return { ok: false, status: 500, text: "nope" };
    };
    fresh.useLinkedCookies("__Secure-1PSID=linked");
    await errorOf(() => fresh.generateContent("hi"));
    delete process.env.GEMINI_AUTH_USER;
    expect("GEMINI_AUTH_USER survives linked cookies", linkedFetches[0], "https://gemini.google.com/u/1/app");
  }

  console.log("\n[6/7] AntigravityClient failover loop to Gemini Web on CloudCode exhaustion ...");
  const antigravity = new AntigravityClient();
  const oauth = OAuthManager.getInstance();

  // Stub single account pool
  (oauth as any).listAccounts = () => ({
    accounts: [{ email: "cloudcode@example.com", projectId: "test-proj", refreshToken: "mock", accessToken: "mock", expiresAt: Date.now() + 10000 }],
    activeIndex: 0,
  });
  (oauth as any).loadSavedAccount = () => ({ email: "cloudcode@example.com", projectId: "test-proj", refreshToken: "mock", accessToken: "mock", expiresAt: Date.now() + 10000 });
  (oauth as any).getValidAccessToken = async () => "mock-token";
  (oauth as any).isAutoFailoverEnabled = () => true;
  // The 429 failover would otherwise read and rewrite the accounts file under $HOME.
  (oauth as any).selectNextAvailableAccount = () => null;
  (oauth as any).findAccountWithWebCookies = () => null;
  // Cookies from the environment would satisfy hasCredentials() on their own.
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ["GEMINI_WEB_COOKIES", "GEMINI_COOKIES", "GEMINI_PSID", "GEMINI_PSIDTS", "GEMINI_AUTH_USER"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Stub fetchWithRetry on AntigravityClient to throw 429
  (antigravity as any).fetchWithRetry = async () => ({
    status: 429,
    statusText: "Too Many Requests",
    text: async () => JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }),
  });

  // Configure GeminiWebClient with fallback response
  client.setCredentials({ rawCookies: "__Secure-1PSID=mock-cookie" });
  let webCalls = 0;
  (client as any).generateContent = async () => (webCalls++, {
    candidates: [
      {
        content: {
          parts: [{ text: "Fallback response from Gemini Web" }],
        },
        finishReason: "STOP",
      },
    ],
  });

  const plain = { model: "gemini-3.8-flash-tiered", request: { contents: [{ role: "user", parts: [{ text: "test prompt" }] }] } };
  const withTools = {
    model: "gemini-3.8-flash-tiered",
    request: { ...plain.request, tools: [{ functionDeclarations: [{ name: "Read", parameters: { type: "object" } }] }] },
  };
  // Off by default: a different provider answering is opt-in.
  delete process.env.GEMINI_WEB_FALLBACK;
  const offErr = await errorOf(() => antigravity.generateContent(plain));
  expect("no fallback without GEMINI_WEB_FALLBACK=1", Boolean(offErr), true);
  expect("the pool's own error (429) reaches the caller", offErr?.status === 429, true);

  process.env.GEMINI_WEB_FALLBACK = "1";
  RateLimitRests.clear();
  const res = await antigravity.generateContent(plain);
  expect("falls back to Gemini Web when opted in", res.candidates[0].content.parts[0].text, "Fallback response from Gemini Web");
  expect("a fallback answer is marked for its usage", res.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);

  RateLimitRests.clear();
  const toolsErr = await errorOf(() => antigravity.generateContent(withTools));
  expect("a request with tools is never answered by the fallback", toolsErr?.status === 429, true);
  RateLimitRests.clear();
  const jsonMode = { model: plain.model, request: { ...plain.request, generationConfig: { responseMimeType: "application/json" } } };
  const jsonErr = await errorOf(() => antigravity.generateContent(jsonMode));
  expect("nor one that asks for structured output", jsonErr?.status === 429, true);

  // Only a pool that ran out falls back: one account's 404 is the caller's to see.
  RateLimitRests.clear();
  const realFetch = (antigravity as any).fetchWithRetry;
  (antigravity as any).fetchWithRetry = async () => ({
    status: 404,
    statusText: "Not Found",
    text: async () => JSON.stringify({ error: { code: 404, message: "model not found" } }),
  });
  const callsBefore = webCalls;
  const notFoundErr = await errorOf(() => antigravity.generateContent(plain));
  expect("a 404 is not answered by the fallback", notFoundErr?.status, 404);
  const streamNotFound = await errorOf(() => antigravity.streamGenerateContent(plain));
  expect("nor on the stream", streamNotFound?.status, 404);
  expect("Gemini Web was not asked", webCalls, callsBefore);
  (antigravity as any).fetchWithRetry = realFetch;

  RateLimitRests.clear();
  (oauth as any).isAutoFailoverEnabled = () => false;
  const failoverOffErr = await errorOf(() => antigravity.generateContent(plain));
  expect("failover off means no fallback", Boolean(failoverOffErr), true);
  (oauth as any).isAutoFailoverEnabled = () => true;

  RateLimitRests.clear();
  const okGenerate = (client as any).generateContent;
  (client as any).generateContent = async () => {
    throw new Error("Gemini Web generation failed with HTTP 401: expired");
  };
  const bothErr = await errorOf(() => antigravity.generateContent(plain));
  expect("a failed fallback keeps the pool's error, not Gemini Web's", bothErr?.status === 429, true);
  (client as any).generateContent = okGenerate;

  // Cookies linked in the dashboard are enough; no Gemini Web model request needed first.
  RateLimitRests.clear();
  (client as any).credentials = null;
  const linkedAccount = { email: "linked@example.com", webCookies: "__Secure-1PSID=linked" };
  (oauth as any).findAccountWithWebCookies = () => linkedAccount;
  // What the fallback reads: the linked sessions it may rotate through (gemini-web-rotation.ts).
  (oauth as any).listAccountsWithWebCookies = () => [linkedAccount];
  const linkedRes = await antigravity.generateContent(plain);
  expect("linked cookies enable the fallback", linkedRes.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);
  expect("and are the credentials it used", (client as any).credentials?.rawCookies, "__Secure-1PSID=linked");

  const stream = await antigravity.streamGenerateContent(plain);
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect("the stream fallback is one chunk", chunks.length, 1);
  expect("the stream chunk is marked too", chunks[0]?.response?.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  console.log("\n[7/7] Model resolution and webRequest ...");
  expect("a provider-prefixed web id resolves to the web id", Transformer.resolveModel("open-design-byok/gemini-neon-4"), "gemini-neon-4");

  // Google's ~29 KB of response headers: Node's fetch refuses them, webRequest must not.
  const bigHeaders = "x".repeat(30 * 1024);
  const local = http.createServer((req, resp) => {
    if (req.url === "/redirect") {
      resp.writeHead(302, { Location: "https://accounts.google.com/" });
      resp.end();
      return;
    }
    if (req.url === "/hang") return; // never answers
    resp.writeHead(200, { "Content-Security-Policy": bigHeaders, "Content-Type": "text/plain" });
    resp.end("big-headers-ok");
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(local.address() as any).port}`;
  try {
    const fetchErr = await errorOf(() => fetch(`${base}/big`));
    expect("(control) Node's fetch overflows on these headers", fetchErr?.cause?.code, "UND_ERR_HEADERS_OVERFLOW");
    const big = await webRequest(`${base}/big`, { method: "GET", headers: {} }, http.request as any);
    expect("webRequest reads a reply with 30 KB of headers", big.text, "big-headers-ok");
    const redirect = await webRequest(`${base}/redirect`, { method: "GET", headers: {} }, http.request as any);
    expect("a redirect is not followed and is not ok", `${redirect.status}/${redirect.ok}`, "302/false");
    process.env.GEMINI_WEB_TIMEOUT_MS = "300";
    const started = Date.now();
    const hangErr = await errorOf(() => webRequest(`${base}/hang`, { method: "GET", headers: {} }, http.request as any));
    expect("a request that never answers times out", /did not answer within 300 ms/.test(String(hangErr?.message)), true);
    expect("the timeout is the configured one", Date.now() - started < 3000, true);
    process.env.GEMINI_WEB_TIMEOUT_MS = "3000000000";
    expect("a timeout past setTimeout's limit falls back to the default", webTimeoutMs(), 180000);
    delete process.env.GEMINI_WEB_TIMEOUT_MS;
    // A port nothing listens on, by a name with two addresses: Node's AggregateError has an empty message.
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const closedPort = (closed.address() as any).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const refused = await errorOf(() => webRequest(`http://localhost:${closedPort}/`, { method: "GET", headers: {} }, http.request as any));
    expect("a refused connection names its cause", /ECONNREFUSED/.test(String(refused?.message)), true);
  } finally {
    delete process.env.GEMINI_WEB_TIMEOUT_MS;
    delete process.env.GEMINI_WEB_FALLBACK;
    local.closeAllConnections?.();
    await new Promise<void>((r) => local.close(() => r()));
  }

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All Gemini Web Fallback assertions passed!");
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
