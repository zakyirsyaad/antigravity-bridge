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
 * And when the pool runs out on a stall, the error has to say so. It could end as
 * "All accounts in the pool are currently rate limited. Please wait for cooldown
 * to reset." — a two-account pool where A had no capacity and B stalled reached
 * it — although a stall writes no cooldown and there is nothing to wait out. A pool
 * that cannot rotate (one account, or failover off) retries in place and used to
 * end in the bare "This operation was aborted"; it gets the same wording now.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import { AntigravityClient } from "../src/antigravity-client";
import { PoolStalledError } from "../src/pool-failures";
import { UpstreamError } from "../src/upstream-error";
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
/** Rotate the way the real selector does: round the pool, past resting accounts. */
let wrapSelector = false;
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
// A walk down the list, except in [6/10], which exercises the real selector, and
// where wrapSelector asks for the real selector's order.
(OAuthManager.prototype as any).selectNextAvailableAccount = function (...args: any[]) {
  if (useRealSelector) return originalSelect.apply(this, args);
  if (wrapSelector) {
    const live = ACCTS.slice(0, poolSize);
    const from = live.findIndex((a) => a.email === current.email);
    for (let offset = 1; offset < live.length; offset++) {
      const candidate = live[(from + offset) % live.length];
      if (candidate.email === args[0] || StallRegistry.isResting(candidate.email)) continue;
      switched++;
      current = candidate;
      return candidate;
    }
    return null;
  }
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

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}
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

const CAPACITY = "No capacity available for model gemini-3.8-flash-tiered on the server";
const QUOTA = "Individual quota reached. Resets in 3h55m50s.";
const THREE_WAITS = "no response to 3 attempts of 0s each";
const RATE_LIMITED = "All accounts in the pool are currently rate limited. Please wait for cooldown to reset.";

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
  wrapSelector = false;
  StallRegistry.clear();
}

async function caught(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * What a client has to be told when Google stopped answering, rather than quota.
 * `waited` is how the wait is said: one attempt when the pool rotated, three when
 * it retried in place.
 */
function expectStallError(label: string, err: any, waited = "no response within 0s") {
  const message = String(err?.message);
  expect(`${label}: threw`, err instanceof Error, true);
  expect(`${label}: names the model`, message.includes(payload.model), true);
  expect(`${label}: says Google stopped answering`, message.includes("stopped answering"), true);
  expect(`${label}: says how long it waited (${waited})`, message.includes(waited), true);
  expect(`${label}: says it is not quota`, message.includes("not quota"), true);
  expect(`${label}: does not say rate limited`, /rate limited|cooldown to reset/i.test(message), false);
  expect(`${label}: worded by PoolFailures as a stall`, err instanceof PoolStalledError && err.kind, "stall");
  // Google answered nothing, so the error carries no Google status: the server
  // answers its generic 500, as a stall always was.
  expect(`${label}: not an UpstreamError (Google sent no status)`, err instanceof UpstreamError, false);
  expect(`${label}: no status`, err?.status, undefined);
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

  console.log("[1/10] The registry rests an account for a while, then forgets it ...");
  StallRegistry.clear();
  StallRegistry.rest("B@Example.com", 300, 1_000_000);
  expect("resting right after", StallRegistry.isResting("b@example.com", 1_000_001), true);
  expect("keys are case-insensitive", StallRegistry.isResting("B@EXAMPLE.COM", 1_000_001), true);
  expect("still resting just before it ends", StallRegistry.isResting("b@example.com", 1_299_999), true);
  expect("rested no longer once the time is up", StallRegistry.isResting("b@example.com", 1_300_001), false);
  expect("another account is unaffected", StallRegistry.isResting("c@example.com", 1_000_001), false);
  expect("no email is never resting", StallRegistry.isResting(undefined), false);

  console.log("\n[2/10] A stalled account is left after one timeout, not three ...");
  reset((acct, init) => (acct.email === "a@example.com" ? hang(init) : ok()));
  expect("request ultimately succeeds", await outcome(() => client.generateContent(payload as any)), "ok");
  expect("the stalled account was tried once", attempts.filter((e) => e === "a@example.com").length, 1);
  expect("then the next account answered", attempts.join(","), "a@example.com,b@example.com");
  expect("rotated exactly once", switched, 1);
  expect("no quota cooldown was written", cooldownsRecorded, 0);
  expect("the stalled account is resting", StallRegistry.isResting("a@example.com"), true);

  console.log("\n[3/10] The streaming path does the same ...");
  reset((acct, init) => (acct.email === "a@example.com" ? hang(init) : okStream()));
  expect("stream ultimately succeeds", await outcome(() => client.streamGenerateContent(payload as any)), "ok");
  expect("stalled account tried once", attempts.filter((e) => e === "a@example.com").length, 1);
  expect("rotated exactly once", switched, 1);
  expect("no quota cooldown was written", cooldownsRecorded, 0);

  console.log("\n[4/10] Rotation is bounded, so a global stall does not sweep the pool ...");
  reset((_a, init) => hang(init));
  const allStalled = await outcome(() => client.generateContent(payload as any));
  expect("gives up with an error that says why", allStalled.startsWith("THREW") && /no response/i.test(allStalled), true);
  expect("three accounts tried, not four", attempts.join(","), "a@example.com,b@example.com,c@example.com");
  expect("two rotations at most", switched, 2);

  console.log("\n[5/10] With nowhere to rotate, the old in-place retries are unchanged, and say why they ended ...");
  reset((_a, init) => hang(init), 1, true);
  let err = await caught(() => client.generateContent(payload as any));
  expect("a single-account pool retries the same account 3 times", attempts.length, 3);
  // It used to end in the bare "This operation was aborted", with no model named.
  expectStallError("single account", err, THREE_WAITS);
  expect("single account: says the account tried", String(err?.message).includes("the account tried"), true);
  expect("single account: nothing rested", StallRegistry.isResting("a@example.com"), false);
  expect("single account: no quota cooldown", cooldownsRecorded, 0);
  reset((_a, init) => hang(init), 1, true);
  err = await caught(() => client.streamGenerateContent(payload as any));
  expect("streaming, single account: 3 tries", attempts.length, 3);
  expectStallError("streaming, single account", err, THREE_WAITS);
  reset((_a, init) => hang(init), 4, false);
  err = await caught(() => client.generateContent(payload as any));
  expect("failover off retries the same account 3 times", attempts.length, 3);
  expect("failover off never rotates", switched, 0);
  expectStallError("failover off", err, THREE_WAITS);
  expect("failover off: nothing rested", StallRegistry.isResting("a@example.com"), false);
  // Only the last attempt decides: one that timed out and then reset is not a stall.
  let calls = 0;
  reset((_a, init) => (calls++ < 2 ? hang(init) : Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))), 1, true);
  err = await caught(() => client.generateContent(payload as any));
  expect("timeouts then a reset: still 3 tries", attempts.length, 3);
  expect("timeouts then a reset: the reset is what is reported", String(err?.message), "fetch failed");
  // Counted as they happened: a reset first, then two timeouts, is two attempts waited out.
  calls = 0;
  reset((_a, init) => (calls++ === 0 ? Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })) : hang(init)), 1, true);
  err = await caught(() => client.generateContent(payload as any));
  expect("a reset then two timeouts: still 3 tries", attempts.length, 3);
  expectStallError("a reset then two timeouts", err, "no response to 2 attempts of 0s each");

  console.log("\n[6/10] The real pool selector skips a resting account, not a cooling one ...");
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

  console.log("\n[7/10] A quick network error still retries in place, and the timeout is configurable ...");
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
  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "30";

  console.log("\n[8/10] A pool that runs out on a stall says so, not \"rate limited\" ...");
  // A has no capacity, so it writes no cooldown and stays selectable; B stalls,
  // the pool rotates back to A, and the loop has spent its two attempts.
  reset((acct, init) => (acct.email === "a@example.com" ? fail(503, CAPACITY) : hang(init)), 2);
  wrapSelector = true;
  err = await caught(() => client.generateContent(payload as any));
  expectStallError("generateContent", err);
  expect("says one of the two stalled", String(err?.message).includes("1 of 2 accounts tried"), true);
  expect("both accounts were tried", attempts.join(","), "a@example.com,b@example.com");
  expect("no quota cooldown was written", cooldownsRecorded, 0);
  expect("the stalled account is resting", StallRegistry.isResting("b@example.com"), true);
  reset((acct, init) => (acct.email === "a@example.com" ? fail(503, CAPACITY) : hang(init)), 2);
  wrapSelector = true;
  err = await caught(() => client.streamGenerateContent(payload as any));
  expectStallError("streamGenerateContent", err);
  expect("stream: no quota cooldown was written", cooldownsRecorded, 0);
  // Counted by account, not by pass: C is resting, so A 503 -> B 503 -> back to A,
  // which stalls. Three passes over two accounts, one of which stalled.
  let visitsToA = 0;
  reset((acct, init) => {
    if (acct.email === "b@example.com") return fail(503, CAPACITY);
    return visitsToA++ === 0 ? fail(503, CAPACITY) : hang(init);
  }, 3);
  wrapSelector = true;
  StallRegistry.rest("c@example.com", 300);
  err = await caught(() => client.generateContent(payload as any));
  expectStallError("an account revisited", err);
  expect("three passes, A twice", attempts.join(","), "a@example.com,b@example.com,a@example.com");
  expect("says 1 of 2 accounts, not 1 of 3 passes", String(err?.message).includes("1 of 2 accounts tried"), true);

  console.log("\n[9/10] ... when every account stalled, and when the rotations are spent ...");
  reset((_a, init) => hang(init), 2);
  wrapSelector = true;
  err = await caught(() => client.generateContent(payload as any));
  expectStallError("both of two stalled", err);
  expect("says both stalled", String(err?.message).includes("both accounts tried"), true);
  reset((_a, init) => hang(init));
  err = await caught(() => client.streamGenerateContent(payload as any));
  expectStallError("rotations spent", err);
  expect("says all three tried stalled", String(err?.message).includes("all 3 accounts tried"), true);
  expect("still three accounts, not four", attempts.length, 3);

  console.log("\n[10/10] A run that ends on a 429 or a 503 keeps its own wording ...");
  // A stalls, B and C answer 429; the stub writes no cooldown, so the pool wraps
  // round to B and the loop runs out on a 429.
  reset((acct, init) => (acct.email === "a@example.com" ? hang(init) : fail(429, QUOTA)), 3);
  wrapSelector = true;
  err = await caught(() => client.generateContent(payload as any));
  expect("last failure a 429 after a stall: rate-limited wording", err?.message, RATE_LIMITED);
  expect("the 429s still recorded their cooldowns", cooldownsRecorded, 2);
  reset((acct, init) => (acct.email === "a@example.com" ? hang(init) : fail(503, CAPACITY)), 2);
  wrapSelector = true;
  err = await caught(() => client.streamGenerateContent(payload as any));
  expect("last failure a 503 after a stall: capacity, status 503", err?.status, 503);
  expect("last failure a 503 after a stall: says capacity", String(err?.message).includes("Google-side capacity"), true);
  delete process.env.BRIDGE_UPSTREAM_TIMEOUT_MS;

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
