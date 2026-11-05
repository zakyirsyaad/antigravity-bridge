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

import { GeminiWebClient } from "../src/gemini-web-client";
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

  const res = await antigravity.generateContent({
    model: "gemini-3.8-flash-tiered",
    request: {
      contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
    },
  });

  expect(
    "falls back to Gemini Web when CloudCode exhausted",
    res.candidates[0].content.parts[0].text,
    "Fallback response from Gemini Web"
  );

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
