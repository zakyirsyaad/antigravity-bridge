/**
 * Offline test suite for Gemini Web Client & Failover Fallback.
 *
 * Verifies:
 * 1. SNlM0e session parameter extraction from HTML.
 * 2. Cookie header formation from discrete __Secure-1PSID / __Secure-1PSIDTS or raw string.
 * 3. Double-JSON RPC payload formatting (f.req array structure).
 * 4. Anti-XSSI prefixed response stream extraction ()]}'\n...).
 * 5. AntigravityClient automatic fallback to Gemini Web when CloudCode pool is rate-limited (429).
 */

import http from "node:http";
import { GeminiWebClient, GEMINI_WEB_FALLBACK_USAGE_ID, webRequest } from "../src/gemini-web-client";
import { Transformer } from "../src/transformer";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";

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

  console.log("[1/5] Extracting session parameters from HTML ...");
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

  console.log("\n[2/5] Building Cookie headers ...");
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

  console.log("\n[3/5] RPC payload double-JSON formatting ...");
  const rpcBody = GeminiWebClient.buildRpcPayload("Hello Gemini Web", "AIzaToken123");
  expect("at param matches token", rpcBody.get("at"), "AIzaToken123");
  const fReqRaw = rpcBody.get("f.req");
  expect("f.req exists", Boolean(fReqRaw), true);
  const outerJson = JSON.parse(fReqRaw || "[]");
  expect("outer json is array of two", Array.isArray(outerJson) && outerJson.length === 2, true);
  const innerJson = JSON.parse(outerJson[1]);
  expect("inner json prompt at index 0", innerJson[0][0], "Hello Gemini Web");

  console.log("\n[4/5] Anti-XSSI response unmarshaling ...");
  const mockAntiXssiResp = `)]}'
342
[["wrb.fr",null,"[[null,null,\\"c_123\\"],null,null,null,[[[\\"rc_abc\\",[\\"Halo! Ada yang bisa saya bantu?\\"]]]]]"]]
`;
  const parsedResp = GeminiWebClient.parseAntiXssiResponse(mockAntiXssiResp);
  const textOutput = parsedResp.candidates?.[0]?.content?.parts?.[0]?.text;
  expect("extracts candidate text cleanly", textOutput, "Halo! Ada yang bisa saya bantu?");

  console.log("\n[4b] Model ids, prompt text, and session handling ...");
  expect("argon resolves to Gemini Web's id", GeminiWebClient.resolveWebModelId("gemini-argon-4"), "95a4c0abcba24364");
  expect("a bridge name is never sent as a model id", GeminiWebClient.resolveWebModelId("gemini-advanced"), null);
  expect("a provider prefix is dropped", GeminiWebClient.isGeminiWebModel("open-design-byok/gemini-auto"), true);
  expect("an unrelated id is not a web model", GeminiWebClient.isGeminiWebModel("gemini-3.8-flash-tiered"), false);
  const rpcAuto = JSON.parse(JSON.parse(GeminiWebClient.buildRpcPayload("hi", "tok", "gemini-auto").get("f.req")!)[1]);
  expect("gemini-auto leaves index 79 empty", rpcAuto[79], null);
  const promptText = GeminiWebClient.requestToPromptText({
    systemInstruction: { parts: [{ text: "Be terse." }] },
    contents: [
      { role: "user", parts: [{ text: "weather?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Berlin" } } }] },
    ],
  });
  expect("system instruction is in the prompt", promptText.startsWith("System: Be terse."), true);
  expect("a prior tool call is in the prompt", promptText.includes('[Tool Call: get_weather({"city":"Berlin"})]'), true);

  const fetched: string[] = [];
  const page = '<script>{"SNlM0e":"tok-1","cfb2h":"bl-1","FdrFJe":"sid-1"}</script>';
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
    const answerText = "Hello there, this is Argon.";
    const xssi = ")]}'\n\n" + JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [["rc_1", [answerText]]]])]]);
    const fresh: GeminiWebClient = new (GeminiWebClient as any)();
    (fresh as any).transport = async (url: string) =>
      url.endsWith("/app") ? { ok: true, status: 200, text: page } : { ok: true, status: 200, text: xssi };
    fresh.setCredentials({ rawCookies: "__Secure-1PSID=x" });
    const prompt = "x".repeat(4001);
    const resp = await fresh.generateContent(prompt, "gemini-argon-4");
    expect("the answer text is parsed", resp.candidates[0].content.parts[0].text, answerText);
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

  console.log("\n[5/5] AntigravityClient failover loop to Gemini Web on CloudCode exhaustion ...");
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

  // Stub fetchWithRetry on AntigravityClient to throw 429
  (antigravity as any).fetchWithRetry = async () => ({
    status: 429,
    statusText: "Too Many Requests",
    text: async () => JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }),
  });

  // Configure GeminiWebClient with fallback response
  client.setCredentials({ rawCookies: "__Secure-1PSID=mock-cookie" });
  (client as any).generateContent = async () => ({
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
  const errorOf = async (run: () => Promise<any>): Promise<any> => {
    try {
      await run();
      return null;
    } catch (err) {
      return err;
    }
  };

  // Off by default: a different provider answering is opt-in.
  delete process.env.GEMINI_WEB_FALLBACK;
  const offErr = await errorOf(() => antigravity.generateContent(plain));
  expect("no fallback without GEMINI_WEB_FALLBACK=1", Boolean(offErr), true);
  expect("the pool's own error (429) reaches the caller", offErr?.status === 429, true);

  process.env.GEMINI_WEB_FALLBACK = "1";
  const res = await antigravity.generateContent(plain);
  expect("falls back to Gemini Web when opted in", res.candidates[0].content.parts[0].text, "Fallback response from Gemini Web");
  expect("a fallback answer is marked for its usage", res.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);

  const toolsErr = await errorOf(() => antigravity.generateContent(withTools));
  expect("a request with tools is never answered by the fallback", toolsErr?.status === 429, true);

  (oauth as any).isAutoFailoverEnabled = () => false;
  const failoverOffErr = await errorOf(() => antigravity.generateContent(plain));
  expect("failover off means no fallback", Boolean(failoverOffErr), true);
  (oauth as any).isAutoFailoverEnabled = () => true;

  const okGenerate = (client as any).generateContent;
  (client as any).generateContent = async () => {
    throw new Error("Gemini Web generation failed with HTTP 401: expired");
  };
  const bothErr = await errorOf(() => antigravity.generateContent(plain));
  expect("a failed fallback keeps the pool's error, not Gemini Web's", bothErr?.status === 429, true);
  (client as any).generateContent = okGenerate;

  // Cookies linked in the dashboard are enough; no Gemini Web model request needed first.
  (client as any).credentials = null;
  (oauth as any).findAccountWithWebCookies = () => ({ email: "linked@example.com", webCookies: "__Secure-1PSID=linked" });
  const linkedRes = await antigravity.generateContent(plain);
  expect("linked cookies enable the fallback", linkedRes.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);

  const stream = await antigravity.streamGenerateContent(plain);
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect("the stream fallback is one chunk", chunks.length, 1);
  expect("the stream chunk is marked too", chunks[0]?.response?.servedBy, GEMINI_WEB_FALLBACK_USAGE_ID);

  console.log("\n[6] Model resolution and webRequest ...");
  expect("a provider-prefixed web id resolves to the web id", Transformer.resolveModel("open-design-byok/gemini-argon-4"), "gemini-argon-4");

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
