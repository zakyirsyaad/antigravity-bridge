/**
 * A Google-refused account (403) must not strand the pool.
 *
 * Live evidence on 2026-11-19 settled the question #50 left open: the verification
 * challenge is per-account, not per-project — three pooled accounts answered while
 * one was refused. Yet a 429 failover moved the active slot onto the refused
 * account, and because 403 did not rotate, every request died on it while healthy
 * accounts sat idle. A 403 now rotates like a 503: no cooldown, the badge stays as
 * a sign, and the selector skips a flagged account while any other is free.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { ACCOUNTS_STORAGE_PATH, USER_HOME } from "../src/constants";
import { clearVerification, flagVerification, isVerificationFlagged } from "../src/account-verification";

const A = "healthy@example.com";
const B = "refused@example.com";
const QUOTA_PATH = path.join(USER_HOME, ".zcode", "antigravity-quota.json");

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
const realChmodSync = fs.chmodSync;
const realStatSync = fs.statSync;
const realRealpathSync = fs.realpathSync;

const account = (email: string) => ({
  email,
  accessToken: email,
  refreshToken: "r-" + email,
  expiresAt: Date.now() + 3_600_000,
  projectId: "p",
});
let accountsContent = JSON.stringify({ accounts: [account(A), account(B)], activeAccountIndex: 0 });
let quotaWrites = 0;
const isAccounts = (p: unknown) => String(p) === ACCOUNTS_STORAGE_PATH;
const isQuota = (p: unknown) => String(p) === QUOTA_PATH;
(fs as any).existsSync = (p: any) => (isAccounts(p) || isQuota(p) ? true : realExistsSync(p));
(fs as any).readFileSync = (p: any, ...rest: any[]) => {
  if (isAccounts(p)) return accountsContent;
  if (isQuota(p)) return '{"perAccount":{}}';
  return (realReadFileSync as any)(p, ...rest);
};
(fs as any).writeFileSync = (p: any, data: any, ...rest: any[]) => {
  if (isAccounts(p)) {
    accountsContent = String(data);
    return;
  }
  if (isQuota(p)) {
    quotaWrites++;
    return;
  }
  return (realWriteFileSync as any)(p, ...rest);
};
(fs as any).chmodSync = (p: any, ...rest: any[]) => (isAccounts(p) ? undefined : (realChmodSync as any)(p, ...rest));
(fs as any).statSync = (p: any, ...rest: any[]) => (isAccounts(p) ? { mode: 0o600 } : (realStatSync as any)(p, ...rest));
(fs as any).realpathSync = (p: any, ...rest: any[]) =>
  isAccounts(p) ? ACCOUNTS_STORAGE_PATH : (realRealpathSync as any)(p, ...rest);

/** Which accounts Google refuses right now, and every bearer token that was sent. */
let refused = new Set<string>([B]);
const sentTokens: string[] = [];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const auth = String(init?.headers?.Authorization || "");
  const email = auth.replace(/^Bearer /, "");
  sentTokens.push(email);
  if (refused.has(email)) {
    return new Response(JSON.stringify({ error: { message: "Verify your account to continue." } }), { status: 403 });
  }
  const u = String(url);
  const body = u.includes("streamGenerateContent")
    ? `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`
    : JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  return new Response(body, { status: 200 });
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

const storage = () => JSON.parse(accountsContent);
const setActive = (email: string) => OAuthManager.getInstance().switchAccountByEmail(email);
const payload: any = {
  model: "gemini-3.8-flash-tiered",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
};
const caught = async (fn: () => Promise<unknown>): Promise<any> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

async function runTests() {
  console.log("=================================================");
  console.log(" A refused account rotates instead of stranding");
  console.log("=================================================\n");
  const client = new AntigravityClient();
  const oauth = OAuthManager.getInstance();

  console.log("[1/4] A 403 on the active account rotates to a healthy one ...");
  clearVerification(A);
  clearVerification(B);
  refused = new Set([B]);
  setActive(B);
  sentTokens.length = 0;
  quotaWrites = 0;
  const ok = await caught(() => client.generateContent(payload));
  expect("the request still answers", ok, null);
  expect("the healthy account served it", sentTokens.includes(A), true);
  expect("the active slot moved off the refused account", storage().accounts[storage().activeAccountIndex].email, A);
  expect("the refused account is flagged for the badge", isVerificationFlagged(B), true);
  expect("a 403 wrote no quota cooldown", quotaWrites, 0);

  console.log("\n[2/4] A flagged active account is skipped before spending a request ...");
  setActive(B);
  sentTokens.length = 0;
  const ok2 = await caught(() => client.generateContent(payload));
  expect("the request answers", ok2, null);
  expect("no request was spent on the flagged account", sentTokens.includes(B), false);
  expect("the healthy one served it", sentTokens[0], A);

  console.log("\n[3/4] The stream path rotates too ...");
  setActive(B);
  sentTokens.length = 0;
  const stream = await caught(async () => {
    const gen = await client.streamGenerateContent(payload);
    for await (const _ of gen) break;
  });
  expect("the stream answers", stream, null);
  expect("it rotated to the healthy account", sentTokens.includes(A), true);

  console.log("\n[4/4] A pool with nowhere to go is not stranded, and flagged accounts are skipped ...");
  accountsContent = JSON.stringify({ accounts: [account(B)], activeAccountIndex: 0 });
  setActive(B);
  refused = new Set([B]);
  const alone = await caught(() => client.generateContent(payload));
  expect("a single refused account still gets its honest 403", alone?.status, 403);
  expect("and is not rotated away from itself", storage().activeAccountIndex, 0);

  accountsContent = JSON.stringify({ accounts: [account(A), account(B)], activeAccountIndex: 1 });
  flagVerification(A);
  clearVerification(B);
  const next = oauth.selectNextAvailableAccount(B, payload.model, "refused");
  expect("the only other account is flagged, so there is nowhere to go", next, null);
  clearVerification(A);
  const next2 = oauth.selectNextAvailableAccount(B, payload.model, "refused");
  expect("once unflagged it is picked", next2?.email, A);

  if (failures > 0) throw new Error(`${failures} refused-rotation check(s) failed`);
  console.log("\n=================================================");
  console.log(" 🎉 ALL REFUSED-ROTATION CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests()
  .catch((e) => {
    console.error("Test failed with error:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    (globalThis as any).fetch = realFetch;
    (fs as any).existsSync = realExistsSync;
    (fs as any).readFileSync = realReadFileSync;
    (fs as any).writeFileSync = realWriteFileSync;
    (fs as any).chmodSync = realChmodSync;
    (fs as any).statSync = realStatSync;
    (fs as any).realpathSync = realRealpathSync;
  });
