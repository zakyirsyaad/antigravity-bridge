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

(OAuthManager.prototype as any).listAccounts = () => ({
  accounts: [
    {
      email: "user@example.com",
      name: "Example User",
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
      projectId: "example-project-1a2b3",
    },
  ],
  activeIndex: 0,
});

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
    console.log("[1/6] GET /api/pool must not leak OAuth tokens ...");
    const poolRes = await fetch(`${SAME_ORIGIN}/api/pool`);
    const poolBody = await poolRes.text();
    expect("status", poolRes.status, 200);
    expect("body contains accessToken", poolBody.includes(FAKE_ACCESS_TOKEN), false);
    expect("body contains refreshToken", poolBody.includes(FAKE_REFRESH_TOKEN), false);
    expect("activeAccount.email still present", JSON.parse(poolBody).activeAccount?.email, "user@example.com");

    console.log("\n[2/6] GET /api/pool must not carry a wildcard CORS header ...");
    expect("access-control-allow-origin", poolRes.headers.get("access-control-allow-origin"), null);

    console.log("\n[3/6] Cross-origin GET /api/pool is rejected ...");
    const foreignGet = await fetch(`${SAME_ORIGIN}/api/pool`, { headers: { Origin: FOREIGN_ORIGIN } });
    expect("status", foreignGet.status, 403);

    console.log("\n[4/6] Cross-origin POST /api/pool/delete is rejected ...");
    const foreignDelete = await fetch(`${SAME_ORIGIN}/api/pool/delete`, {
      method: "POST",
      headers: { Origin: FOREIGN_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect("status", foreignDelete.status, 403);

    console.log("\n[5/6] Same-origin management POST still works ...");
    const sameOriginPost = await fetch(`${SAME_ORIGIN}/api/pool/toggle`, {
      method: "POST",
      headers: { Origin: SAME_ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect("status", sameOriginPost.status, 200);

    console.log("\n[6/6] Inference endpoints keep permissive CORS ...");
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
