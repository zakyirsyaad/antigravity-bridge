/**
 * Test for Task 1: Hybrid AccountToken schema and linkWebCookies() in OAuthManager.
 */

import http from "node:http";
import { OAuthManager, AccountToken } from "../src/oauth";
import { BridgeServer } from "../src/server";
import { GeminiWebClient } from "../src/gemini-web-client";
import { UsageTracker } from "../src/usage-tracker";

// The Gemini Web routes record usage; keep it off the real ~/.zcode counters.
(UsageTracker.getInstance() as any).recordUsage = () => {};

const TEST_PORT = 52149;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function postJson(pathUrl: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${BASE_URL}${pathUrl}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data: any = {};
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 0, data, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log("=================================================");
  console.log(" Hybrid Account & Gemini Web Offline Test Suite");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();

  // Test in-memory storage
  const mockStorage = {
    accounts: [
      {
        email: "hybrid.user@example.com",
        name: "Hybrid User",
        accessToken: "mock-access",
        refreshToken: "mock-refresh",
        expiresAt: Date.now() + 100000,
        projectId: "test-proj",
      },
    ] as AccountToken[],
    activeAccountIndex: 0,
  };

  (oauth as any).readStorage = () => mockStorage;
  (oauth as any).writeStorage = (s: any) => {
    mockStorage.accounts = s.accounts;
    mockStorage.activeAccountIndex = s.activeAccountIndex;
  };
  (oauth as any).listAccounts = () => ({
    accounts: mockStorage.accounts,
    activeIndex: mockStorage.activeAccountIndex,
  });

  console.log("[1/5] Task 1 Unit: linkWebCookies checks ...");
  expect("returns false for unknown email", oauth.linkWebCookies("unknown@example.com", "__Secure-1PSID=mock-psid"), false);
  expect("returns false for empty cookie", oauth.linkWebCookies("hybrid.user@example.com", "   "), false);
  expect("successfully links valid cookie", oauth.linkWebCookies("hybrid.user@example.com", "__Secure-1PSID=token-123;"), true);
  expect("persists webCookies", Boolean(mockStorage.accounts[0].webCookies?.includes("token-123")), true);
  expect("pool reports hasWebCookies true", (oauth as any).getPoolStatus().accounts[0].hasWebCookies, true);

  console.log("\n[2/5] Task 2 Endpoint: POST /api/accounts/link-web ...");
  const server = new BridgeServer(TEST_PORT);
  await server.start();

  try {
    const resBad = await postJson("/api/accounts/link-web", {});
    expect("rejects missing body with 400", resBad.status, 400);

    const resCors = await postJson(
      "/api/accounts/link-web",
      { email: "hybrid.user@example.com", cookies: "__Secure-1PSID=abc" },
      { Origin: "https://attacker.site" }
    );
    expect("blocks foreign origin with 403", resCors.status, 403);

    const resSuccess = await postJson("/api/accounts/link-web", {
      email: "hybrid.user@example.com",
      cookies: "__Secure-1PSID=abc-cookie-val;",
    });
    expect("link-web returns 200", resSuccess.status, 200);
    expect("response carries hasWebCookies", resSuccess.data.hasWebCookies, true);
    expect("response never leaks cookie", resSuccess.raw.includes("abc-cookie-val"), false);

    console.log("\n[3/5] Task 3 Routing: gemini-argon-4 routes to Gemini Web ...");
    const geminiWeb = GeminiWebClient.getInstance();
    (geminiWeb as any).generateContent = async (req: any) => ({
      candidates: [{ content: { parts: [{ text: "Hello from Gemini Argon 4" }] }, finishReason: "STOP" }],
    });

    const resArgon = await postJson("/v1/chat/completions", {
      model: "gemini-argon-4",
      messages: [{ role: "user", content: "Tell me something cool" }],
    });
    expect("argon request answers 200", resArgon.status, 200);
    expect(
      "content generated from Gemini Web",
      resArgon.data.choices?.[0]?.message?.content,
      "Hello from Gemini Argon 4"
    );

    console.log("\n[4/5] Model routing check helper & /v1/models listing ...");
    expect("detects gemini-argon-4 as web model", GeminiWebClient.isGeminiWebModel("gemini-argon-4"), true);
    expect("detects gemini-auto as web model", GeminiWebClient.isGeminiWebModel("gemini-auto"), true);
    expect("detects prefixed google/gemini-auto as web model", GeminiWebClient.isGeminiWebModel("google/gemini-auto"), true);
    expect("detects claude-opus as non-web model", GeminiWebClient.isGeminiWebModel("claude-opus-4-6-thinking"), false);

    // Verify /v1/models lists gemini-argon-4 when hybrid account is linked
    const modelsRes = await new Promise<{ data: any[] }>((resolve) => {
      http.get(`${BASE_URL}/v1/models`, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      });
    });
    const argonInList = modelsRes.data?.find((m: any) => m.id === "gemini-argon-4");
    expect("/v1/models exposes gemini-argon-4", Boolean(argonInList), true);
    expect("gemini-argon-4 owned_by", argonInList?.owned_by, "google-gemini-web");

    console.log("\n[5/5] Token refresh preserves webCookies and webLinkedAt ...");
    const accBefore = mockStorage.accounts[0];
    expect("accBefore has webCookies", Boolean(accBefore.webCookies), true);
    // Simulate saveAccount with refreshed OAuth token without webCookies
    oauth.saveAccount({
      email: accBefore.email,
      name: accBefore.name,
      accessToken: "new-access-token",
      refreshToken: accBefore.refreshToken,
      expiresAt: Date.now() + 3600000,
      projectId: accBefore.projectId,
    });
    const accAfter = mockStorage.accounts[0];
    expect("preserves webCookies across token refresh", Boolean(accAfter.webCookies), true);
    expect("accessToken updated", accAfter.accessToken, "new-access-token");

  } finally {
    await server.stop();
  }

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All Hybrid Account assertions passed!");
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
