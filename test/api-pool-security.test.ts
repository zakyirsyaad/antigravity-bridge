/**
 * Regression guard for management-API credential exposure.
 *
 * getPoolStatus() used to return `activeAccount` as a full AccountToken, and
 * server.ts serialized it verbatim on the unauthenticated GET /api/pool, which
 * was also served with `Access-Control-Allow-Origin: *`. Any page the user had
 * open could read their Google refresh token — a credential that does not
 * expire and carries cloud-platform scope — and could also drive the POST
 * mutation endpoints, including account deletion.
 *
 * Accounts are stubbed with synthetic tokens, so this suite never reads
 * ~/.zcode/antigravity-accounts.json, touches no real credentials, makes no
 * network call and consumes no quota. Safe to run in CI.
 */
import { OAuthManager } from "../src/oauth";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52140;
const SAME_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const FOREIGN_ORIGIN = "https://evil.example";

/** Sentinels that must never appear in a management-API response body. */
const FAKE_ACCESS_TOKEN = "ya29.SYNTHETIC-ACCESS-TOKEN-DO-NOT-LEAK";
const FAKE_REFRESH_TOKEN = "1//SYNTHETIC-REFRESH-TOKEN-DO-NOT-LEAK";
const FAKE_WEB_COOKIES = "__Secure-1PSID=SYNTHETIC-WEB-COOKIE-DO-NOT-LEAK";

const STUB_ACCOUNT = {
  email: "user@example.com",
  name: "Example User",
  accessToken: FAKE_ACCESS_TOKEN,
  refreshToken: FAKE_REFRESH_TOKEN,
  webCookies: FAKE_WEB_COOKIES,
  expiresAt: Date.now() + 3_600_000,
  projectId: "example-project-1a2b3",
};

(OAuthManager.prototype as any).listAccounts = () => ({
  accounts: [STUB_ACCOUNT],
  activeIndex: 0,
});

// Switching writes the accounts file; answer with the stored record instead, as the real one does.
(OAuthManager.prototype as any).switchAccount = () => ({ ...STUB_ACCOUNT });
(OAuthManager.prototype as any).loadSavedAccount = () => ({ ...STUB_ACCOUNT });

// Keep the live-quota lookup in /api/pool offline.
(OAuthManager.prototype as any).getValidAccessTokenForAccount = async () => {
  throw new Error("quota lookup disabled in tests");
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

async function runTests() {
  console.log("=================================================");
  console.log(" Management API credential-exposure regression");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT} (accounts stubbed)\n`);

  try {
    console.log("[1/8] GET /api/pool must not leak OAuth tokens ...");
    const poolRes = await fetch(`${SAME_ORIGIN}/api/pool`);
    const poolBody = await poolRes.text();
    expect("status", poolRes.status, 200);
    expect("body contains accessToken", poolBody.includes(FAKE_ACCESS_TOKEN), false);
    expect("body contains refreshToken", poolBody.includes(FAKE_REFRESH_TOKEN), false);
    expect("body contains web cookies", poolBody.includes(FAKE_WEB_COOKIES), false);
    expect("activeAccount.email still present", JSON.parse(poolBody).activeAccount?.email, "user@example.com");

    console.log("\n[2/8] GET /api/pool must not carry a wildcard CORS header ...");
    expect("access-control-allow-origin", poolRes.headers.get("access-control-allow-origin"), null);

    console.log("\n[3/8] POST /api/pool/switch answers a summary, not the stored account ...");
    const switchRes = await fetch(`${SAME_ORIGIN}/api/pool/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const switchBody = await switchRes.text();
    expect("status", switchRes.status, 200);
    expect("body contains accessToken", switchBody.includes(FAKE_ACCESS_TOKEN), false);
    expect("body contains refreshToken", switchBody.includes(FAKE_REFRESH_TOKEN), false);
    expect("body contains web cookies", switchBody.includes(FAKE_WEB_COOKIES), false);
    expect("active.email still present", JSON.parse(switchBody).active?.email, "user@example.com");
    expect("active.hasWebCookies says the link exists", JSON.parse(switchBody).active?.hasWebCookies, true);

    console.log("\n[4/8] /v1/usage names the pool's accounts, so a foreign page cannot read it ...");
    for (const route of ["/v1/usage", "/usage"]) {
      const foreignUsage = await fetch(`${SAME_ORIGIN}${route}`, { headers: { Origin: FOREIGN_ORIGIN } });
      expect(`${route} cross-origin status`, foreignUsage.status, 403);
      expect(`${route} cross-origin CORS header`, foreignUsage.headers.get("access-control-allow-origin"), null);
    }
    const sameUsage = await fetch(`${SAME_ORIGIN}/v1/usage`, { headers: { Origin: SAME_ORIGIN } });
    const sameUsageBody = await sameUsage.text();
    expect("/v1/usage same-origin status", sameUsage.status, 200);
    expect("/v1/usage without an Origin (curl) status", (await fetch(`${SAME_ORIGIN}/v1/usage`)).status, 200);
    expect("/v1/usage carries no token", sameUsageBody.includes(FAKE_ACCESS_TOKEN) || sameUsageBody.includes(FAKE_REFRESH_TOKEN), false);
    expect("/v1/usage carries no cookie", sameUsageBody.includes(FAKE_WEB_COOKIES), false);

    console.log("\n[5/8] Cross-origin GET /api/pool is rejected ...");
    const foreignGet = await fetch(`${SAME_ORIGIN}/api/pool`, { headers: { Origin: FOREIGN_ORIGIN } });
    expect("status", foreignGet.status, 403);

    console.log("\n[6/8] Cross-origin POST /api/pool/delete is rejected ...");
    const foreignDelete = await fetch(`${SAME_ORIGIN}/api/pool/delete`, {
      method: "POST",
      headers: { Origin: FOREIGN_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect("status", foreignDelete.status, 403);

    console.log("\n[7/8] Same-origin management POST still works ...");
    const sameOriginPost = await fetch(`${SAME_ORIGIN}/api/pool/toggle`, {
      method: "POST",
      headers: { Origin: SAME_ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect("status", sameOriginPost.status, 200);

    console.log("\n[8/8] Inference endpoints keep permissive CORS ...");
    const modelsRes = await fetch(`${SAME_ORIGIN}/v1/models`);
    expect("access-control-allow-origin", modelsRes.headers.get("access-control-allow-origin"), "*");

    if (failures > 0) {
      throw new Error(`${failures} management-API security check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL SECURITY CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
