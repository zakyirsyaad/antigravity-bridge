/**
 * Test for Task 1: Hybrid AccountToken schema and linkWebCookies() in OAuthManager.
 */

import { OAuthManager, AccountToken } from "../src/oauth";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function runTask1Tests() {
  console.log("=================================================");
  console.log(" Task 1: OAuthManager.linkWebCookies Unit Test");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();

  // Test in-memory storage
  const mockStorage = {
    accounts: [
      {
        email: "test.user@example.com",
        name: "Test User",
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

  console.log("[1/3] Reject non-existent email ...");
  const notFound = oauth.linkWebCookies("unknown@example.com", "__Secure-1PSID=mock-psid");
  expect("returns false for unknown email", notFound, false);

  console.log("\n[2/3] Reject empty or invalid cookie string ...");
  const invalidCookie = oauth.linkWebCookies("test.user@example.com", "   ");
  expect("returns false for empty cookie", invalidCookie, false);

  console.log("\n[3/3] Successfully link valid cookie string ...");
  const linked = oauth.linkWebCookies("test.user@example.com", "__Secure-1PSID=mock-psid-token-xyz; __Secure-1PSIDTS=ts-123;");
  expect("returns true on successful link", linked, true);

  const updatedAccount = mockStorage.accounts[0];
  expect("preserves existing refreshToken", updatedAccount.refreshToken, "mock-refresh");
  expect("persists webCookies string", updatedAccount.webCookies?.includes("__Secure-1PSID=mock-psid-token-xyz"), true);
  expect("sets webLinkedAt timestamp", typeof updatedAccount.webLinkedAt, "number");

  const status = (oauth as any).getPoolStatus();
  expect("pool account status reports hasWebCookies true", status.accounts[0].hasWebCookies, true);

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: Task 1 tests passed!");
  }
}

runTask1Tests();
