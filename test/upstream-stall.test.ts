/**
 * Regression guard for what the bridge does when Google simply stops answering.
 *
 * Google sometimes holds a request without replying — no response and no 429 or
 * 503 — in bursts that last several minutes and follow a run of large requests on
 * one account. The client aborted at 60 s and retried the SAME account twice more,
 * so one request spent three minutes on a stalled account, ended as a 500, and the
 * caller's own retry did it again: OpenDesign's run died after three such
 * 3-minute 500s in a row, with the other five accounts idle.
 *
 * Now, when failover is on and another account exists, the first timeout rotates
 * instead: the stalled account is rested in memory for a few minutes (no quota
 * cooldown is written — it is not out of quota, it is just not answering), and the
 * request goes to the next one. Rotation is bounded, quick network errors still
 * retry in place, and with nowhere to rotate to the old retries are unchanged.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { ACCOUNTS_STORAGE_PATH, USER_HOME } from "../src/constants";
import { StallRegistry, UpstreamStall, upstreamTimeoutMs } from "../src/upstream-stall";

const QUOTA_PATH = path.join(USER_HOME, ".zcode", "antigravity-quota.json");
const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
const EMPTY_QUOTA = '{"perAccount":{}}';
let quotaContent = EMPTY_QUOTA;
let accountsContent = "{}";
const isQuota = (p: unknown) => String(p) === QUOTA_PATH;
const isAccounts = (p: unknown) => String(p) === ACCOUNTS_STORAGE_PATH;
(fs as any).existsSync = (p: any) => (isQuota(p) || isAccounts(p) ? true : realExistsSync(p));
(fs as any).readFileSync = (p: any, ...rest: any[]) => {
  if (isQuota(p)) return quotaContent;
  if (isAccounts(p)) return accountsContent;
  return (realReadFileSync as any)(p, ...rest);
};
(fs as any).writeFileSync = (p: any, data: any, ...rest: any[]) => {
  if (isQuota(p)) {
    quotaContent = String(data);
    return;
  }
  if (isAccounts(p)) {
    accountsContent = String(data);
    return;
  }
  return (realWriteFileSync as any)(p, data, ...rest);
};

const ACCTS = ["a", "b", "c", "d"].map((n) => ({ email: `${n}@example.com`, projectId: "p", refreshToken: "r" }));
let poolSize = 4;
let failoverOn = true;
let useRealSelector = false;
let current: any = ACCTS[0];
let switched = 0;
let cooldownsRecorded = 0;
let attempts: string[] = [];
let respond: (account: any, init: any) => Promise<Response> | Response = () => ok();

const originalSelect = (OAuthManager.prototype as any).selectNextAvailableAccount;
(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => failoverOn;
(OAuthManager.prototype as any).listAccounts = () => ({ accounts: ACCTS.slice(0, poolSize), activeIndex: 0 });
// A walk down the list, except in [6/7], which exercises the real selector.
(OAuthManager.prototype as any).selectNextAvailableAccount = function (...args: any[]) {
  if (useRealSelector) return originalSelect.apply(this, args);
  const i = ACCTS.findIndex((a) => a.email === current.email);
  const next = ACCTS.slice(0, poolSize)[i + 1];
  if (!next) return null;
  switched++;
  current = next;
  return next;
};
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {
  cooldownsRecorded++;
};

(globalThis as any).fetch = async (_url: string, init: any) => {
  attempts.push(current.email);
  return respond(current, init);
};

function ok(): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
}
function okStream(): Response {
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`, { status: 200 });
}
/** A request Google never answers: it settles only when the bridge gives up on it. */
function hang(init: any): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
    );
  });
}

const payload = {
  model: "gemini-3.8-flash-tiered",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
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

function reset(responder: (account: any, init: any) => Promise<Response> | Response, size = 4, failover = true) {
  current = ACCTS[0];
  switched = 0;
  cooldownsRecorded = 0;
  attempts = [];
  respond = responder;
  poolSize = size;
  failoverOn = failover;
  useRealSelector = false;
  StallRegistry.clear();
}

async function outcome(call: () => Promise<any>): Promise<string> {
  try {
    const res: any = await call();
    if (res && typeof res[Symbol.asyncIterator] === "function") {
      let text = "";
      for await (const chunk of res) text += chunk?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return text;
    }
    return res?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (e: any) {
    return `THREW ${e.message}`;
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" An upstream that stops answering rotates the pool");
  console.log("=================================================\n");

  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "30";
  const client = new AntigravityClient();

  console.log("[1/7] The registry rests an account for a while, then forgets it ...");
  StallRegistry.clear();
  StallRegistry.rest("B@Example.com", 300, 1_000_000);
  expect("resting right after", StallRegistry.isResting("b@example.com", 1_000_001), true);
  expect("keys are case-insensitive", StallRegistry.isResting("B@EXAMPLE.COM", 1_000_001), true);
  expect("still resting just before it ends", StallRegistry.isResting("b@example.com", 1_299_999), true);
  expect("rested no longer once the time is up", StallRegistry.isResting("b@example.com", 1_300_001), false);
  expect("another account is unaffected", StallRegistry.isResting("c@example.com", 1_000_001), false);
  expect("no email is never resting", StallRegistry.isResting(undefined), false);

  console.log("\n[2/7] A stalled account is left after one timeout, not three ...");
  reset((acct, init) => (acct.email === "a@example.com" ? hang(init) : ok()));
  expect("request ultimately succeeds", await outcome(() => client.generateContent(payload as any)), "ok");
  expect("the stalled account was tried once", attempts.filter((e) => e === "a@example.com").length, 1);
  expect("then the next account answered", attempts.join(","), "a@example.com,b@example.com");
  expect("rotated exactly once", switched, 1);
  expect("no quota cooldown was written", cooldownsRecorded, 0);
  expect("the stalled account is resting", StallRegistry.isResting("a@example.com"), true);

  console.log("\n[3/7] The streaming path does the same ...");
  reset((acct, init) => (acct.email === "a@example.com" ? hang(init) : okStream()));
  expect("stream ultimately succeeds", await outcome(() => client.streamGenerateContent(payload as any)), "ok");
  expect("stalled account tried once", attempts.filter((e) => e === "a@example.com").length, 1);
  expect("rotated exactly once", switched, 1);
  expect("no quota cooldown was written", cooldownsRecorded, 0);

  console.log("\n[4/7] Rotation is bounded, so a global stall does not sweep the pool ...");
  reset((_a, init) => hang(init));
  const allStalled = await outcome(() => client.generateContent(payload as any));
  expect("gives up with an error that says why", allStalled.startsWith("THREW") && /no response/i.test(allStalled), true);
  expect("three accounts tried, not four", attempts.join(","), "a@example.com,b@example.com,c@example.com");
  expect("two rotations at most", switched, 2);

  console.log("\n[5/7] With nowhere to rotate, the old in-place retries are unchanged ...");
  reset((_a, init) => hang(init), 1, true);
  const single = await outcome(() => client.generateContent(payload as any));
  expect("a single-account pool retries the same account 3 times", attempts.length, 3);
  expect("and then fails", single.startsWith("THREW"), true);
  reset((_a, init) => hang(init), 4, false);
  await outcome(() => client.generateContent(payload as any));
  expect("failover off retries the same account 3 times", attempts.length, 3);
  expect("failover off never rotates", switched, 0);

  console.log("\n[6/7] The real pool selector skips a resting account, not a cooling one ...");
  reset(() => ok());
  useRealSelector = true;
  quotaContent = EMPTY_QUOTA;
  const writeAccounts = () =>
    (accountsContent = JSON.stringify({ activeAccountIndex: 0, accounts: ACCTS.slice(0, 3) }));
  const oauth = OAuthManager.getInstance();
  writeAccounts();
  StallRegistry.rest("b@example.com", 300);
  expect("b is resting, so a's next is c", oauth.selectNextAvailableAccount("a@example.com", payload.model)?.email, "c@example.com");
  expect("the pool's active account moved to c", JSON.parse(accountsContent).activeAccountIndex, 2);
  expect("resting wrote nothing to the quota file", quotaContent, EMPTY_QUOTA);
  writeAccounts();
  StallRegistry.clear();
  StallRegistry.rest("b@example.com", 300, Date.now() - 400_000);
  expect("once the rest is over b is chosen again", oauth.selectNextAvailableAccount("a@example.com", payload.model)?.email, "b@example.com");
  writeAccounts();
  StallRegistry.clear();
  StallRegistry.rest("b@example.com", 300);
  StallRegistry.rest("c@example.com", 300);
  expect("every other account resting: nothing to switch to", oauth.selectNextAvailableAccount("a@example.com", payload.model), null);
  useRealSelector = false;

  console.log("\n[7/7] A quick network error still retries in place, and the timeout is configurable ...");
  let resets = 0;
  reset(() => {
    if (resets++ === 0) throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    return ok();
  });
  expect("recovers without rotating", await outcome(() => client.generateContent(payload as any)), "ok");
  expect("same account both times", attempts.join(","), "a@example.com,a@example.com");
  expect("no rotation for a reset connection", switched, 0);
  expect("nothing rested", StallRegistry.isResting("a@example.com"), false);
  delete process.env.BRIDGE_UPSTREAM_TIMEOUT_MS;
  expect("the default timeout is 60 s", upstreamTimeoutMs(), 60000);
  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "90000";
  expect("an env value overrides it", upstreamTimeoutMs(), 90000);
  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "junk";
  expect("a junk value falls back to the default", upstreamTimeoutMs(), 60000);
  expect("UpstreamStall is exported", typeof UpstreamStall, "function");

  if (failures > 0) {
    throw new Error(`${failures} upstream-stall check(s) failed`);
  }
}

runTests()
  .then(() => {
    console.log("\n=================================================");
    console.log(" 🎉 ALL UPSTREAM STALL CHECKS PASSED!");
    console.log("=================================================\n");
  })
  .catch((e) => {
    console.error("Test failed with error:", e.message);
    process.exit(1);
  });
