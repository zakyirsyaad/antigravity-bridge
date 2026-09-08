/**
 * Regression guard for cross-account token bleed during refresh.
 *
 * getValidAccessToken() used to deduplicate concurrent refreshes with a single
 * instance-wide `refreshPromise` that was not keyed by account. Because a 429
 * failover swaps the active account at any moment, a caller that had just
 * loaded account B could be handed account A's access token — which the client
 * then paired with B's projectId, and any resulting 429 was recorded against
 * the wrong account, putting a healthy one into cooldown.
 *
 * refreshAccessToken() had the same defect one level down: it read the module
 * -global `memoryToken` for email/name/projectId *after* awaiting the token
 * endpoint, so a failover mid-flight stamped the refreshed token with another
 * account's identity, and saveAccount() matches on email — overwriting that
 * account's stored entry.
 *
 * Everything here is stubbed: no disk access to ~/.zcode, no network call, no
 * real credential, no quota. Safe to run in CI.
 */
import { OAuthManager } from "../src/oauth";

type Acct = {
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  projectId: string;
};

// expiresAt 0 => always considered expired, so every call forces a refresh.
const ALICE: Acct = {
  email: "alice@example.com",
  name: "Alice",
  accessToken: "stale-alice",
  refreshToken: "refresh-alice",
  expiresAt: 0,
  projectId: "project-alice",
};
const BOB: Acct = {
  email: "bob@example.com",
  name: "Bob",
  accessToken: "stale-bob",
  refreshToken: "refresh-bob",
  expiresAt: 0,
  projectId: "project-bob",
};

const POOL = [ALICE, BOB];
/** Which account loadSavedAccount() reports — flipped mid-flight to model failover. */
let active: Acct = ALICE;
/** Everything handed to saveAccount(), so we can assert what got persisted. */
let savedRecords: any[] = [];

(OAuthManager.prototype as any).loadSavedAccount = () => active;
(OAuthManager.prototype as any).listAccounts = () => ({ accounts: POOL, activeIndex: POOL.indexOf(active) });
(OAuthManager.prototype as any).saveAccount = (token: any) => {
  savedRecords.push(token);
};

let tokenFetchCount = 0;
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};

function closeGate() {
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.includes("oauth2.googleapis.com/token")) {
    tokenFetchCount++;
    const refreshToken = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
    await gate; // hold the refresh open so we can interleave a failover
    return new Response(JSON.stringify({ access_token: `fresh-for-${refreshToken}`, expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`unexpected network call in test: ${url}`);
}) as any;

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
  console.log(" Token refresh cross-account race regression");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();

  console.log("[1/3] Concurrent refresh of the SAME account is deduplicated ...");
  active = ALICE;
  tokenFetchCount = 0;
  savedRecords = [];
  closeGate();
  const p1 = oauth.getValidAccessToken();
  const p2 = oauth.getValidAccessToken();
  openGate();
  const [a1, a2] = await Promise.all([p1, p2]);
  expect("network refreshes issued", tokenFetchCount, 1);
  expect("caller 1 token", a1, "fresh-for-refresh-alice");
  expect("caller 2 token", a2, "fresh-for-refresh-alice");

  console.log("\n[2/3] Failover mid-refresh must not bleed A's token to B ...");
  active = ALICE;
  tokenFetchCount = 0;
  savedRecords = [];
  closeGate();
  const aliceCall = oauth.getValidAccessToken(); // starts refresh for alice, blocks on gate
  active = BOB; // 429 failover swaps the active account while alice is in flight
  const bobCall = oauth.getValidAccessToken(); // must NOT reuse alice's in-flight promise
  openGate();
  const [aliceToken, bobToken] = await Promise.all([aliceCall, bobCall]);
  expect("network refreshes issued", tokenFetchCount, 2);
  expect("alice caller token", aliceToken, "fresh-for-refresh-alice");
  expect("bob caller token", bobToken, "fresh-for-refresh-bob");

  console.log("\n[3/3] Each refreshed token is stored under its OWN identity ...");
  expect("accounts persisted", savedRecords.length, 2);
  for (const record of savedRecords) {
    const owner = POOL.find((a) => a.refreshToken === record.refreshToken);
    expect(`${record.refreshToken} -> email`, record.email, owner?.email);
    expect(`${record.refreshToken} -> projectId`, record.projectId, owner?.projectId);
  }

  if (failures > 0) {
    throw new Error(`${failures} token-refresh check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL REFRESH-RACE CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
