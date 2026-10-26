/**
 * Regression guard for what the dashboard is told about the pool.
 *
 * An account resting after a stall is skipped by failover for a few minutes, but
 * `/api/pool` reported it as plain "ready", so the dashboard drew it green and the
 * "Ready for Gemini" figure counted an account failover would not pick. It is now a
 * status of its own, "resting", with the time it ends. It is not a cooldown: the
 * account is not out of quota, and a real quota cooldown still wins the one-word status.
 *
 * And a failover event used to read only "switched from A to B", so a 429, a 503
 * and a stall all looked the same in the activity stream. Every failover now says
 * why, and the client passes that reason from each place it moves the pool.
 *
 * The dashboard half runs the page's own inline script against a bare-bones DOM, so what
 * it draws for a rest, how that clock counts down, and what it says when the clock runs out
 * are checked as behaviour, not as source text.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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

  // BRIDGE_STALL_REST_SECONDS has no upper bound, and a rest too far out for a Date to hold must
  // not take /api/pool down with a RangeError from toISOString(). 1e308 overflows to Infinity.
  for (const seconds of ["1e13", "1e308"]) {
    reset();
    process.env.BRIDGE_STALL_REST_SECONDS = seconds;
    let tooLong: any = null;
    let tooLongError: string | null = null;
    try {
      StallRegistry.rest("b@example.com");
      tooLong = oauth.getPoolStatus();
    } catch (e: any) {
      tooLongError = e.message;
    } finally {
      delete process.env.BRIDGE_STALL_REST_SECONDS;
    }
    expect(`a rest of ${seconds} s does not break /api/pool`, tooLongError, null);
    expect(`${seconds} s: the account still reads resting`, tooLong && byEmail(tooLong, "b@example.com").status, "resting");
    expect(
      `${seconds} s: with a finite time left, so the JSON keeps a number`,
      tooLong && Number.isFinite(byEmail(tooLong, "b@example.com").resting.remainingMs),
      true
    );
  }

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

  console.log("\n[5/6] The client passes the reason, and the request's model, from every place it moves the pool ...");
  const seen: Array<string | undefined> = [];
  // Cooldowns are per model family, so each call that judges or moves the pool must carry the
  // request's model: one that drops it asks about every family at once (CLAUDE.md: load-bearing).
  // A stub handed any other model leaves a mark in `seen`, which fails the scenario that made the call.
  const wantModel = (who: string, model: unknown) => {
    if (model !== payload.model) seen.push(`${who}(${String(model)})`);
  };
  let current: any = ACCTS[0];
  let streaming = false;
  let respond: (init: any) => Promise<Response> | Response = () => ok(streaming);
  (OAuthManager.prototype as any).loadSavedAccount = () => current;
  (OAuthManager.prototype as any).getValidAccessToken = async () => "token";
  (OAuthManager.prototype as any).isAutoFailoverEnabled = () => true;
  (OAuthManager.prototype as any).selectNextAvailableAccount = (_email: string, model: string, reason?: string) => {
    wantModel("selectNextAvailableAccount", model);
    seen.push(reason);
    current = ACCTS[(ACCTS.indexOf(current) + 1) % ACCTS.length];
    return current;
  };
  let limited = new Set<string>();
  // How often the client asked whether an account is limited, and which cooldowns run out right
  // after the first answer that says so (the quota file is re-read on every ask).
  let asks = 0;
  let endsAfterFirstAsk = new Set<string>();
  (QuotaTracker.prototype as any).isAccountRateLimited = (email: string, model?: string) => {
    wantModel("isAccountRateLimited", model);
    asks++;
    const answer = limited.has(email);
    if (answer && endsAfterFirstAsk.has(email)) limited.delete(email);
    return answer;
  };
  (QuotaTracker.prototype as any).record429 = (_email: string, _message: string, model?: string) =>
    wantModel("record429", model);
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
    endsAfterFirstAsk = new Set();
    asks = 0;
    StallRegistry.clear();
    respond = (init) => (calls++ === 0 ? failure(init) : ok(streaming));
  };

  // Every scenario runs on both entry points: each path has its own copy of every call site.
  const restA = () => StallRegistry.rest("a@example.com", 300);
  const limitA = () => limited.add("a@example.com");
  const scenarios: Array<[string, string, (init: any) => Promise<Response> | Response, (() => void)?]> = [
    ["429 -> quota", "quota", () => fail(429, "Individual quota reached. Resets in 1h0m0s.")],
    ["503 no capacity -> no_capacity", "no_capacity", () => fail(503, "No capacity available for model gemini-3-flash on the server")],
    ["other 503 -> unavailable", "unavailable", () => fail(503, "The service is currently unavailable.")],
    ["stall -> stall", "stall", (init) => hang(init)],
    ["active account resting -> resting", "resting", () => ok(streaming), restA],
    ["active account cooling -> cooling_down", "cooling_down", () => ok(streaming), limitA],
    // Cooling on the request's family and resting at once: the family's own cooldown is the more
    // specific reason, and the card draws that row as cooling too.
    ["cooling and resting -> cooling_down", "cooling_down", () => ok(streaming), () => (limitA(), restA())],
    // The answer that moved the pool is the reason: a cooldown that runs out right after the client
    // read it still names the cooldown, not a rest that never happened.
    [
      "a cooldown that ends between two reads -> cooling_down",
      "cooling_down",
      () => ok(streaming),
      () => (limitA(), endsAfterFirstAsk.add("a@example.com")),
    ],
  ];
  const entryPoints: Array<[string, () => Promise<unknown>]> = [
    ["", () => client.generateContent(payload as any)],
    ["stream: ", () => streamAll(client, payload)],
  ];
  for (const [label, wanted, first, arrange] of scenarios) {
    for (const [prefix, call] of entryPoints) {
      firstFails(first);
      arrange?.();
      await call();
      expect(prefix + label, seen.join(","), wanted);
    }
  }
  for (const [prefix, call] of entryPoints) {
    firstFails(() => ok(streaming));
    limitA();
    await call();
    expect(`${prefix}the proactive check asks the quota file once, for the move and for the reason`, asks, 1);
  }
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

  // A rest is judged by what the bridge says is left, not by this browser's idea of the time: a viewer
  // whose clock runs ahead of the bridge's must still see a rest that is running.
  const realNow = Date.now;
  const withClockAhead = <T>(ms: number, run: () => T): T => {
    Date.now = () => realNow() + ms;
    try {
      return run();
    } finally {
      Date.now = realNow;
    }
  };
  expect(
    "a rest is still live for a viewer whose clock runs 5 min ahead",
    withClockAhead(300_000, () => ui.readyFor(restingAcc, "gemini")),
    false
  );

  // What the whole page draws from one /api/pool answer, and what its once-a-second ticker then
  // does to the clocks it drew: the page's own script, against a bare-bones DOM.
  const page = runDashboard(html);
  const poolOf = (accounts: any[]) => ({ totalAccounts: accounts.length, autoFailoverEnabled: true, recentEvents: [], accounts });
  const claudeCooling = {
    families: { claude: { fiveHour: { resetsAt: new Date(Date.now() + 3_600_000).toISOString(), resetMessage: "Resets in 1h0m0s" } } },
  };
  const [restCard, bothCard, readyCard] = page.draw(
    poolOf([
      { ...restingAcc, email: "rest@example.com", status: "resting" },
      // The API ranks any cooldown above a rest for its one-word status; the card works per family.
      { ...restingAcc, email: "both@example.com", status: "cooling_down", quota: claudeCooling },
      { ...readyAcc, email: "ready@example.com", status: "ready" },
    ])
  );
  const rows = (card: string): string[] => card.match(/<div class="family-row">.*?<\/div>/g) ?? [];
  const said = (card: string) => rows(card).map((row) => row.replace(/<[^>]*>/g, "")).join(" | ");
  expect("a resting account's rows say Resting, with the countdown", said(restCard), "GeminiResting · 2m 0s | ClaudeResting · 2m 0s | GPT-OSSResting · 2m 0s");
  expect("their dots are drawn resting", rows(restCard).every((row) => row.includes("family-dot is-resting")), true);
  expect("a cooldown on one family outranks the rest on that row", said(bothCard), "GeminiResting · 2m 0s | ClaudeCooling · 1h0m0s | GPT-OSSResting · 2m 0s");
  expect("and its dot is the cooling one", rows(bothCard)[1].includes("family-dot is-cooling"), true);
  expect("a plain account's rows still say Ready", said(readyCard), "GeminiReady | ClaudeReady | GPT-OSSReady");
  expect("the card chip says Resting", restCard.includes("◌ Resting"), true);
  expect("a cooldown on one family does not hide the rest from the card chip", bothCard.includes("chip-resting"), true);
  expect("Ready for Gemini leaves both resting accounts out", page.text("kpiGeminiReady"), "1 / 3");
  expect("a rest is not a quota cooldown: no Clear Cooldown button", restCard.includes("Clear Cooldown"), false);
  expect("a real cooldown still has one", bothCard.includes("Clear Cooldown"), true);
  const restClockAt = new Date(rows(restCard)[0].match(/data-reset="([^"]*)"/)?.[1] ?? "").getTime();
  expect("a rest's clock counts down to about two minutes from now", Math.abs(restClockAt - (Date.now() + 120_000)) < 2_000, true);
  const chipTag = restCard.match(/<span class="status-chip chip-resting"[^>]*>/)?.[0] ?? "";
  expect("the Resting tooltip says the skip depends on auto-failover", chipTag.includes("auto-failover"), true);

  // The same rest drawn by a browser whose clock runs 5 min ahead still counts the bridge's own 2 min.
  const [skewedCard] = withClockAhead(300_000, () =>
    page.draw(poolOf([{ ...restingAcc, email: "rest@example.com", status: "resting" }]))
  );
  const skewedClock = clockOf(rows(skewedCard)[0]);
  withClockAhead(300_000, () => page.tick([skewedClock]));
  expect("a fast viewer clock still counts the rest's own 2 min", /^(2m 0s|1m 59s)$/.test(skewedClock.textContent), true);

  // A rest of an hour or more reads the same on the first paint and on the ticker that follows it.
  const [longCard] = page.draw(
    poolOf([
      {
        ...restingAcc,
        email: "long@example.com",
        status: "resting",
        resting: { remainingMs: 7_198_500, resetsAt: new Date(Date.now() + 7_198_500).toISOString() },
      },
    ])
  );
  expect("a rest of two hours reads hours on the first paint", said(longCard), "GeminiResting · 1h 59m | ClaudeResting · 1h 59m | GPT-OSSResting · 1h 59m");
  const longClock = clockOf(rows(longCard)[0]);
  page.tick([longClock]);
  expect("and the ticker agrees with it", longClock.textContent, "1h 59m");

  // A drawn clock as the browser holds it once its time is up: the markup's own data-done, the instant in the past.
  const endedRest = clockOf(rows(restCard)[0], gone);
  const endedCooldown = clockOf(rows(bothCard)[1], gone);
  page.tick([endedRest, endedCooldown]);
  expect("a rest that ran out between polls reads 'ending'", endedRest.textContent, "ending");
  expect("a cooldown that ran out still reads 'ready to reset'", endedCooldown.textContent, "ready to reset");

  // Resting is neutral in every theme, so its rules must not borrow a theme's accent tokens.
  const ruleBody = (selector: string): string =>
    html.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  for (const selector of [".chip-resting", ".family-dot.is-resting"]) {
    const body = ruleBody(selector);
    expect(`${selector} draws from fixed colours, not a theme's tokens`, body.length > 0 && !/var\(--(border-active|text-muted)\)/.test(body), true);
  }

  // The tooltip is markup, so it is read as markup, but it has to name every trigger, not just end well.
  const failoverTag = html.match(/<[^>]*id="toggleFailoverBtn"[^>]*>/)?.[0] ?? "";
  const failoverTitle = failoverTag.match(/title="([^"]*)"/)?.[1] ?? "";
  for (const trigger of ["429", "503", "stall"]) {
    expect(`the failover tooltip names ${trigger}`, failoverTitle.includes(trigger), true);
  }

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
/**
 * A clock element as the browser holds it, taken from the markup's own attributes. The
 * instant can be moved to simulate time passing.
 */
function clockOf(row: string, resetsAt?: string) {
  const attrs: Record<string, string | undefined> = {
    "data-reset": resetsAt ?? row.match(/data-reset="([^"]*)"/)?.[1],
    "data-done": row.match(/data-done="([^"]*)"/)?.[1],
  };
  return { textContent: "", getAttribute: (name: string) => attrs[name] ?? null };
}
/**
 * Run the dashboard's whole inline script against a bare-bones DOM and hand back what it
 * draws. Nothing is fetched (`fetch` never answers) and the page's timers are captured,
 * not started, so the once-a-second clock ticker can be run by hand. A DOM call the script
 * gains later throws here: extend the stub below rather than skipping the page.
 */
function runDashboard(html: string) {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const byId = new Map<string, any>();
  const timers: Array<{ run: () => void; everyMs: number }> = [];
  let clocks: any[] = [];
  const stub = (): any => ({
    children: [] as any[],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child: any) {
      this.children.push(child);
    },
    addEventListener() {},
    setAttribute() {},
  });
  // The page reads the clock through the Date it is handed, so a test can move that clock (a browser
  // that disagrees with the bridge) without moving its own.
  class PageDate extends Date {
    static now(): number {
      return Date.now();
    }
  }
  const sandbox: any = {
    Date: PageDate,
    document: {
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, stub());
        return byId.get(id);
      },
      createElement: stub,
      querySelectorAll: () => clocks,
      documentElement: stub(),
    },
    window: { location: { origin: "https://bridge.example", hostname: "bridge.example", port: "" } },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),
    setInterval: (run: () => void, everyMs: number) => timers.push({ run, everyMs }),
    console,
  };
  vm.runInNewContext(script, sandbox);
  return {
    /** Draw a pool answer; returns each account card's HTML. */
    draw: (data: unknown): string[] => {
      const container = sandbox.document.getElementById("accountsContainer");
      container.children = [];
      sandbox.renderStitchDashboard(data);
      return container.children.map((card: any) => card.innerHTML as string);
    },
    text: (id: string): string => byId.get(id).textContent,
    /** Run the one-second ticker over these clock elements. */
    tick: (elements: any[]) => {
      clocks = elements;
      timers.find((t) => t.everyMs === 1000)!.run();
    },
  };
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
