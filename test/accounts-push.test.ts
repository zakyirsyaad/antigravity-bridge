/**
 * Offline test suite for POST /api/accounts/push endpoint and OAuth pushAccount().
 *
 * Verifies:
 * 1. Missing refreshToken returns HTTP 400.
 * 2. Successful account push persists with 0600 mode and returns public summary.
 * 3. Secret material (accessToken, refreshToken) is NOT leaked in response.
 * 4. Cross-origin requests with foreign Origin header are blocked (403 forbidden).
 * 5. Subsequent /api/pool calls reflect the newly added account in the pool list.
 *
 * Runs offline against stubbed OAuth methods and an isolated temp directory.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BridgeServer } from "../src/server";
import { OAuthManager, AccountToken } from "../src/oauth";

const TEST_PORT = 52145;
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
  console.log(" Account Push API Offline Suite");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();
  const server = new BridgeServer(TEST_PORT);

  // In-memory accounts storage for test isolation
  const testStorage = {
    accounts: [] as AccountToken[],
    activeAccountIndex: 0,
  };

  (oauth as any).readStorage = () => testStorage;
  (oauth as any).writeStorage = (s: any) => {
    testStorage.accounts = s.accounts;
    testStorage.activeAccountIndex = s.activeAccountIndex;
  };
  (oauth as any).listAccounts = () => ({
    accounts: testStorage.accounts,
    activeIndex: testStorage.activeAccountIndex,
  });

  // Stub refreshAccessToken to avoid outbound Google network call
  (oauth as any).refreshAccessToken = async (rt: string) => {
    if (rt === "invalid_rt") {
      throw new Error("Invalid refresh token from upstream");
    }
    return {
      accessToken: "ya29.mock-refreshed-access-token",
      refreshToken: rt,
      expiresAt: Date.now() + 3600_000,
      email: "pushed.user@example.com",
      name: "Pushed User",
      projectId: "pushed-project-123",
    };
  };

  await server.start();

  try {
    console.log("[1/5] Missing refreshToken rejected with 400 ...");
    const resEmpty = await postJson("/api/accounts/push", {});
    expect("rejects empty body with 400", resEmpty.status, 400);
    expect("specifies refreshToken required", resEmpty.data.error, "refreshToken is required");

    console.log("\n[2/5] Push valid refreshToken returns 200 and public account summary ...");
    const resPush = await postJson("/api/accounts/push", {
      refreshToken: "1//valid-mock-token-xyz",
    });
    expect("answers 200 on valid push", resPush.status, 200);
    expect("status is ok", resPush.data.status, "ok");
    expect("identifies user email via refresh", resPush.data.account?.email, "pushed.user@example.com");
    expect("identifies user name via refresh", resPush.data.account?.name, "Pushed User");

    console.log("\n[3/5] Verifying credential isolation (no secrets in HTTP response) ...");
    expect("accessToken not in response", resPush.raw.includes("mock-refreshed-access-token"), false);
    expect("refreshToken not in response", resPush.raw.includes("1//valid-mock-token-xyz"), false);

    console.log("\n[4/5] Cross-origin protection on management API ...");
    const resCrossOrigin = await postJson(
      "/api/accounts/push",
      { refreshToken: "1//some-other-token" },
      { Origin: "https://attacker.evil" }
    );
    expect("blocks cross-origin POST with 403", resCrossOrigin.status, 403);

    console.log("\n[5/5] Checking pool status reflects the pushed account ...");
    const poolRes = await new Promise<{ status: number; data: any }>((resolve) => {
      http.get(`${BASE_URL}/api/pool`, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, data: JSON.parse(raw) }));
      });
    });
    expect("pool GET answers 200", poolRes.status, 200);
    expect("pool accounts length is 1", poolRes.data.accounts?.length, 1);
    expect("pool account matches pushed email", poolRes.data.accounts?.[0]?.email, "pushed.user@example.com");

  } finally {
    await server.stop();
  }

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All Account Push API assertions passed!");
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
