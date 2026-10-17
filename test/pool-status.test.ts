/**
 * Regression guard for what the dashboard is told about the pool.
 *
 * An account resting after a stall is skipped by failover for a few minutes, but
 * `/api/pool` reported it as plain "ready", so the dashboard drew it green and the
 * "Ready for Gemini" figure counted an account failover would not pick. It is now a
 * status of its own, "resting", with the time it ends. It is not a cooldown: the
 * account is not out of quota, and a real quota cooldown still wins over it.
 *
 * And a failover event used to read only "switched from A to B", so a 429, a 503
 * and a stall all looked the same in the activity stream. Every failover now says
 * why, and the client passes that reason from each place it moves the pool.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { ACCOUNTS_STORAGE_PATH, USER_HOME } from "../src/constants";
import { StallRegistry } from "../src/upstream-stall";

const QUOTA_PATH = path.join(USER_HOME, ".zcode", "antigravity-quota.json");
const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
let accountsContent = "{}";
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
  if (isQuota(p)) return;
  return (realWriteFileSync as any)(p, data, ...rest);
};

const SECRET = "refresh-token-that-must-never-leave";
const ACCTS = ["a", "b", "c"].map((n) => ({
  email: `${n}@example.com`,
  projectId: "p",
  accessToken: "access",
  refreshToken: SECRET + n,
  expiresAt: Date.now() + 3_600_000,
}));
let activeIndex = 0;
let cooling = new Set<string>();

(OAuthManager.prototype as any).listAccounts = () => ({ accounts: ACCTS, activeIndex });
(QuotaTracker.prototype as any).getAccountCooldownRemaining = (email: string) =>
  cooling.has(email)
    ? { remainingMs: 3_600_000, resetMessage: "Resets in 1h0m0s", resetsAt: new Date(Date.now() + 3_600_000).toISOString() }
    : null;
(QuotaTracker.prototype as any).getQuotaForAccount = () => ({});

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label}: wanted ${String(wanted)}, got ${String(actual)}`);
  }
}

function reset() {
  activeIndex = 0;
  cooling = new Set();
  StallRegistry.clear();
}

const byEmail = (status: any, email: string) => status.accounts.find((a: any) => a.email === email);

async function runTests() {
  console.log("=================================================");
  console.log(" The dashboard is told why the pool moved");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();

  console.log("[1/6] A resting account has its own status, with the time it ends ...");
  reset();
  StallRegistry.rest("b@example.com", 300);
  let status: any = oauth.getPoolStatus();
  const b = byEmail(status, "b@example.com");
  expect("b is resting", b.status, "resting");
  expect("b's rest is in the future", b.resting && b.resting.remainingMs > 0 && b.resting.remainingMs <= 300_000, true);
  expect(
    "b's resetsAt is about five minutes out",
    Math.abs(new Date(b.resting.resetsAt).getTime() - (Date.now() + 300_000)) < 2_000,
    true
  );
  expect("b is not a cooldown", b.cooldown, null);
  expect("a is active", byEmail(status, "a@example.com").status, "active");
  expect("a has no rest", byEmail(status, "a@example.com").resting, null);
  expect("readyCount leaves the resting account out", status.readyCount, 2);
  expect("restingCount counts it", status.restingCount, 1);
  expect("coolingDownCount does not", status.coolingDownCount, 0);

  console.log("\n[2/6] A quota cooldown wins over a rest, and the active account can rest too ...");
  reset();
  cooling.add("c@example.com");
  StallRegistry.rest("c@example.com", 300);
  StallRegistry.rest("a@example.com", 300);
  status = oauth.getPoolStatus();
  expect("c, cooling and resting, reads cooling", byEmail(status, "c@example.com").status, "cooling_down");
  expect("c still carries its rest", Boolean(byEmail(status, "c@example.com").resting), true);
  expect("the active account a reads resting", byEmail(status, "a@example.com").status, "resting");
  expect("a is still marked active", byEmail(status, "a@example.com").isActive, true);
  expect("only b is ready", status.readyCount, 1);
  expect("one cooling", status.coolingDownCount, 1);
  expect("one resting (cooling wins for c)", status.restingCount, 1);

  console.log("\n[3/6] A rest that is over is forgotten ...");
  reset();
  StallRegistry.rest("b@example.com", 300, Date.now() - 400_000);
  status = oauth.getPoolStatus();
  expect("b is ready again", byEmail(status, "b@example.com").status, "ready");
  expect("b has no rest", byEmail(status, "b@example.com").resting, null);
  expect("restingCount is zero", status.restingCount, 0);
  expect("the pool status carries no OAuth token", JSON.stringify(status).includes(SECRET), false);

  console.log("\n[4/6] A failover event says why, and names the model ...");
  reset();
  const writeAccounts = () => (accountsContent = JSON.stringify({ activeAccountIndex: 0, accounts: ACCTS }));
  const reasons: Array<[any, string]> = [
    ["quota", "429 quota reached"],
    ["no_capacity", "503 no capacity"],
    ["unavailable", "503 service unavailable"],
    ["stall", "no response from Google (stall)"],
    ["cooling_down", "it was cooling down"],
    ["resting", "it was resting after a stall"],
  ];
  for (const [reason, text] of reasons) {
    writeAccounts();
    oauth.selectNextAvailableAccount("a@example.com", "gemini-3-flash", reason);
    const evt = oauth.getPoolEvents()[0];
    expect(`${reason}: event type`, evt.type, "failover");
    expect(`${reason}: event reason`, evt.reason, reason);
    expect(`${reason}: message says why`, evt.message.endsWith(`: ${text} · gemini-3-flash`), true);
  }
  writeAccounts();
  oauth.selectNextAvailableAccount("a@example.com");
  const bare = oauth.getPoolEvents()[0];
  expect("no reason: the old message", bare.message, "Auto-failover switched from a@example.com to b@example.com");
  expect("no reason: no reason field", bare.reason, undefined);

  console.log("\n[5/6] The client passes the reason from every place it moves the pool ...");
  const seen: Array<string | undefined> = [];
  let current: any = ACCTS[0];
  let streaming = false;
  let respond: (init: any) => Promise<Response> | Response = () => ok(streaming);
  (OAuthManager.prototype as any).loadSavedAccount = () => current;
  (OAuthManager.prototype as any).getValidAccessToken = async () => "token";
  (OAuthManager.prototype as any).isAutoFailoverEnabled = () => true;
  (OAuthManager.prototype as any).selectNextAvailableAccount = (_email: string, _model: string, reason?: string) => {
    seen.push(reason);
    current = ACCTS[(ACCTS.indexOf(current) + 1) % ACCTS.length];
    return current;
  };
  let limited = new Set<string>();
  (QuotaTracker.prototype as any).isAccountRateLimited = (email: string) => limited.has(email);
  (QuotaTracker.prototype as any).record429 = () => {};
  let calls = 0;
  (globalThis as any).fetch = async (url: string, init: any) => {
    streaming = String(url).includes("streamGenerateContent");
    return respond(init);
  };
  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "30";
  const client = new AntigravityClient();
  const payload = { model: "gemini-3-flash", request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } };
  const firstFails = (failure: (init: any) => Promise<Response> | Response) => {
    calls = 0;
    seen.length = 0;
    current = ACCTS[0];
    limited = new Set();
    StallRegistry.clear();
    respond = (init) => (calls++ === 0 ? failure(init) : ok(streaming));
  };

  firstFails(() => fail(429, "Individual quota reached. Resets in 1h0m0s."));
  await client.generateContent(payload as any);
  expect("429 -> quota", seen.join(","), "quota");
  firstFails(() => fail(503, "No capacity available for model gemini-3-flash on the server"));
  await client.generateContent(payload as any);
  expect("503 no capacity -> no_capacity", seen.join(","), "no_capacity");
  firstFails(() => fail(503, "The service is currently unavailable."));
  await client.generateContent(payload as any);
  expect("other 503 -> unavailable", seen.join(","), "unavailable");
  firstFails((init) => hang(init));
  await client.generateContent(payload as any);
  expect("stall -> stall", seen.join(","), "stall");
  firstFails(() => fail(429, "Individual quota reached. Resets in 1h0m0s."));
  await streamAll(client, payload);
  expect("stream: 429 -> quota", seen.join(","), "quota");
  firstFails(() => fail(503, "No capacity available for model gemini-3-flash on the server"));
  await streamAll(client, payload);
  expect("stream: 503 no capacity -> no_capacity", seen.join(","), "no_capacity");

  firstFails(() => ok(streaming));
  StallRegistry.rest("a@example.com", 300);
  await client.generateContent(payload as any);
  expect("active account resting -> resting", seen.join(","), "resting");
  firstFails(() => ok(streaming));
  limited.add("a@example.com");
  await client.generateContent(payload as any);
  expect("active account cooling -> cooling_down", seen.join(","), "cooling_down");
  firstFails(() => ok(streaming));
  limited.add("a@example.com");
  await streamAll(client, payload);
  expect("stream: active account cooling -> cooling_down", seen.join(","), "cooling_down");
  // The streaming path has its own copies of every call site, so each reason is checked there too.
  firstFails(() => fail(503, "The service is currently unavailable."));
  await streamAll(client, payload);
  expect("stream: other 503 -> unavailable", seen.join(","), "unavailable");
  firstFails((init) => hang(init));
  await streamAll(client, payload);
  expect("stream: stall -> stall", seen.join(","), "stall");
  firstFails(() => ok(streaming));
  StallRegistry.rest("a@example.com", 300);
  await streamAll(client, payload);
  expect("stream: active account resting -> resting", seen.join(","), "resting");
  // Cooling and resting at once: the cooldown outlasts the rest, so it is the reason,
  // as the dashboard ranks it.
  firstFails(() => ok(streaming));
  limited.add("a@example.com");
  StallRegistry.rest("a@example.com", 300);
  await client.generateContent(payload as any);
  expect("cooling and resting -> cooling_down", seen.join(","), "cooling_down");
  firstFails(() => ok(streaming));
  limited.add("a@example.com");
  StallRegistry.rest("a@example.com", 300);
  await streamAll(client, payload);
  expect("stream: cooling and resting -> cooling_down", seen.join(","), "cooling_down");
  delete process.env.BRIDGE_UPSTREAM_TIMEOUT_MS;

  console.log("\n[6/6] The dashboard draws a rest, and its failover tooltip names every trigger ...");
  const html = realReadFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf-8") as string;
  // The page's own functions, run as the browser would: behaviour, not source text.
  const ui = pageFunctions(html, ["familyCooldown", "restingWindow", "readyFor", "statusChip"]);
  const soon = new Date(Date.now() + 120_000).toISOString();
  const gone = new Date(Date.now() - 1_000).toISOString();
  const restingAcc = { isActive: false, quota: {}, resting: { remainingMs: 120_000, resetsAt: soon } };
  const coolingAcc = { isActive: false, quota: { fiveHour: { resetsAt: soon } }, resting: null };
  const readyAcc = { isActive: false, quota: {}, resting: null };
  expect("a resting account is not ready for Gemini", ui.readyFor(restingAcc, "gemini"), false);
  expect("nor for Claude", ui.readyFor(restingAcc, "claude"), false);
  expect("a cooling account is not ready", ui.readyFor(coolingAcc, "gemini"), false);
  expect("a plain account is ready", ui.readyFor(readyAcc, "gemini"), true);
  expect(
    "a rest that is over no longer counts",
    ui.readyFor({ ...restingAcc, resting: { remainingMs: 0, resetsAt: gone } }, "gemini"),
    true
  );
  const chip = (acc: any, cooling: number) => ui.statusChip(acc, cooling, 3, ui.restingWindow(acc)) as string;
  expect("resting -> Resting chip", chip(restingAcc, 0).includes("◌ Resting"), true);
  expect("the resting chip is not amber", chip(restingAcc, 0).includes("chip-cooling"), false);
  expect("the active account resting says both", chip({ ...restingAcc, isActive: true }, 0).includes("● Active · Resting"), true);
  expect("resting with one family cooling still reads Resting", chip(restingAcc, 1).includes("Resting"), true);
  expect("resting and every family cooling reads Cooling", chip(restingAcc, 3).includes("⏳ Cooling"), true);
  expect("the active account, not resting, reads Active", chip({ ...readyAcc, isActive: true }, 0).includes("● Active</span>"), true);
  expect("a plain account reads Ready", chip(readyAcc, 0).includes(">Ready<"), true);
  expect("an ended rest's clock does not say 'ready to reset'", html.includes('data-done="ending"'), true);
  expect("the tooltip no longer says only HTTP 429", html.includes('title="Toggle automatic failover on HTTP 429"'), false);
  expect("the tooltip names a stall", /title="Toggle automatic failover:[^"]*stall"/.test(html), true);

  if (failures > 0) {
    throw new Error(`${failures} pool status check(s) failed`);
  }
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}
function ok(stream: boolean): Response {
  const chunk = { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
  return new Response(stream ? `data: ${JSON.stringify(chunk)}\n\n` : JSON.stringify(chunk), { status: 200 });
}
/** A request Google never answers: it settles only when the bridge gives up on it. */
function hang(init: any): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
    );
  });
}
/**
 * Lift named top-level `function` declarations out of the dashboard's inline script
 * and evaluate them together, so their behaviour can be checked without a browser.
 */
function pageFunctions(html: string, names: string[]): Record<string, (...args: any[]) => any> {
  const sources = names.map((name) => {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`dashboard.html has no function ${name}()`);
    let depth = 0;
    for (let i = html.indexOf("{", start); i < html.length; i++) {
      if (html[i] === "{") depth++;
      if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`could not read function ${name}()`);
  });
  return new Function(`${sources.join("\n")}\nreturn { ${names.join(", ")} };`)();
}
async function streamAll(client: AntigravityClient, payload: any): Promise<void> {
  const stream: any = await client.streamGenerateContent(payload);
  for await (const _ of stream) {
    // drain
  }
}

runTests()
  .then(() => {
    console.log("\n=================================================");
    console.log(" 🎉 ALL POOL STATUS CHECKS PASSED!");
    console.log("=================================================\n");
  })
  .catch((e) => {
    console.error("Test failed with error:", e.message);
    process.exit(1);
  });
