/**
 * Recovery from Google's account-verification 403 without a terminal.
 *
 * "Verify your account to continue." is Google refusing the account. The bridge
 * answers a real 403 for it (test/upstream-errors.test.ts), but the operator still
 * had to know which account was flagged and reach for a CLI login. This suite
 * covers the dashboard route instead: the flag that names the account, the pool
 * field that carries it to the page, the Re-login button that targets it, and the
 * consent URL that preselects it.
 *
 * The flag blocks nothing. Routing keeps trying the account, because whether the
 * challenge is per-account or per-project is not known, and skipping it could
 * strand a single-account pool. It is a sign on the card, not a rest.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import { pageFunctions, pageFunctionSource } from "./dashboard-functions";
import { AntigravityClient } from "../src/antigravity-client";
import { UpstreamError } from "../src/upstream-error";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { UsageTracker } from "../src/usage-tracker";
import { BridgeServer } from "../src/server";
import { ACCOUNTS_STORAGE_PATH, USER_HOME } from "../src/constants";
import {
  clearVerification,
  flagDisabled,
  flagVerification,
  isAccountDisabled,
  isAccountRefused,
  isVerificationFlagged,
  refusalRecovery,
} from "../src/account-verification";

/** Google's words when it has disabled an account outright (seen 2026-10-21 and 2026-11-21). */
const DISABLED = "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.";

const TEST_PORT = 52155;
const QUOTA_PATH = path.join(USER_HOME, ".zcode", "antigravity-quota.json");
const VERIFY = "Verify your account to continue.";
const EMAIL = "a@example.com";
const OTHER = "b@example.com";

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
const realChmodSync = fs.chmodSync;
const realStatSync = fs.statSync;
const realRealpathSync = fs.realpathSync;

/** The fake accounts file, so a re-login is observable without touching ~/.zcode. */
let accountsContent = JSON.stringify({ accounts: [], activeAccountIndex: 0 });
/** Writes attempted against the quota file: a 403 must never record a cooldown. */
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
// A write tightens the file's mode first; left alone, that would reach the real file.
(fs as any).chmodSync = (p: any, ...rest: any[]) => (isAccounts(p) ? undefined : (realChmodSync as any)(p, ...rest));
(fs as any).statSync = (p: any, ...rest: any[]) => (isAccounts(p) ? { mode: 0o600 } : (realStatSync as any)(p, ...rest));
(fs as any).realpathSync = (p: any, ...rest: any[]) =>
  isAccounts(p) ? ACCOUNTS_STORAGE_PATH : (realRealpathSync as any)(p, ...rest);

const ACCTS = [EMAIL, OTHER].map((email, i) => ({
  email,
  name: email.charAt(0).toUpperCase(),
  projectId: "p",
  accessToken: "access",
  refreshToken: `refresh-${i}`,
  expiresAt: Date.now() + 3_600_000,
}));

(OAuthManager.prototype as any).listAccounts = () => ({ accounts: ACCTS, activeIndex: 0 });
(OAuthManager.prototype as any).loadSavedAccount = () => ACCTS[0];
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).getValidAccessTokenForAccount = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => false;
(OAuthManager.prototype as any).selectNextAvailableAccount = () => null;
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => false;
(QuotaTracker.prototype as any).getAccountCooldownRemaining = () => null;
(QuotaTracker.prototype as any).getQuotaForAccount = () => ({});
(UsageTracker.prototype as any).recordUsage = () => {};

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

const realGenerate = AntigravityClient.prototype.generateContent;
const realStream = AntigravityClient.prototype.streamGenerateContent;
const realGetWebOAuthUrl = OAuthManager.prototype.getWebOAuthUrl;

async function runTests() {
  console.log("=================================================");
  console.log(" A refused account can be recovered from the page");
  console.log("=================================================\n");

  console.log("[1/6] The flag names one account and blocks nothing ...");
  expect(
    "the verification book exports its three calls",
    [flagVerification, clearVerification, isVerificationFlagged].every((fn) => typeof fn === "function"),
    true
  );
  clearVerification(EMAIL);
  expect("an account that answered is not flagged", isVerificationFlagged(EMAIL), false);
  flagVerification(EMAIL);
  expect("a 403 flags the account it came from", isVerificationFlagged(EMAIL), true);
  expect("the book is case-insensitive", isVerificationFlagged("A@Example.com"), true);
  expect("another account is untouched", isVerificationFlagged(OTHER), false);
  clearVerification(EMAIL);
  expect("clearing unflags it", isVerificationFlagged(EMAIL), false);
  flagVerification(undefined);
  expect("no email flags nothing", isVerificationFlagged(undefined), false);

  console.log("\n[2/6] Google's 403 flags the account, and an answer clears it ...");
  const realFetch = globalThis.fetch;
  const payload: any = {
    model: "gemini-3.8-flash-tiered",
    request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
  };
  const client = new AntigravityClient();
  const caught = async (fn: () => Promise<unknown>): Promise<any> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  const googleReplies = (status: number, message403 = VERIFY) => {
    (globalThis as any).fetch = async (url: any) => {
      const ok = String(url).includes("streamGenerateContent")
        ? `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`
        : JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
      const body = status === 403 ? JSON.stringify({ error: { message: message403 } }) : ok;
      return new Response(body, { status });
    };
  };
  try {
    clearVerification(EMAIL);
    googleReplies(403);
    const genErr = await caught(() => realGenerate.call(client, payload));
    expect("generateContent: Google's status is kept", genErr?.status, 403);
    expect("generateContent: the account is flagged", isVerificationFlagged(EMAIL), true);

    clearVerification(EMAIL);
    const streamErr = await caught(() => realStream.call(client, payload));
    expect("streamGenerateContent: Google's status is kept", streamErr?.status, 403);
    expect("streamGenerateContent: the account is flagged too", isVerificationFlagged(EMAIL), true);

    googleReplies(200);
    await caught(() => realGenerate.call(client, payload));
    expect("an account that answers again is no longer flagged", isVerificationFlagged(EMAIL), false);

    flagVerification(EMAIL);
    await caught(() => realStream.call(client, payload));
    expect("the stream path clears it as well", isVerificationFlagged(EMAIL), false);
    expect("a 403 wrote no quota cooldown", quotaWrites, 0);

    // A 403 can also be plain permission denial. The badge claims a verification
    // challenge, so it must only appear when Google actually asked for one.
    clearVerification(EMAIL);
    googleReplies(403, "Permission denied on the requested project.");
    const plainErr = await caught(() => realGenerate.call(client, payload));
    expect("a non-verification 403 keeps its status", plainErr?.status, 403);
    expect("but does not claim a verification challenge", isVerificationFlagged(EMAIL), false);
    expect("and is not taken for a disabled account", isAccountDisabled(EMAIL), false);
    expect("so the pool does not skip it", isAccountRefused(EMAIL), false);

    // An account Google disabled is its own state: no login clears it, only Google's appeal.
    googleReplies(403, DISABLED);
    const disabledErr = await caught(() => realGenerate.call(client, payload));
    expect("a disabled account keeps Google's status", disabledErr?.status, 403);
    expect("it is marked disabled", isAccountDisabled(EMAIL), true);
    expect("not as needing verification", isVerificationFlagged(EMAIL), false);
    expect("and the pool skips it", isAccountRefused(EMAIL), true);
    clearVerification(EMAIL);
    await caught(() => realStream.call(client, payload));
    expect("the stream path marks it too", isAccountDisabled(EMAIL), true);
    googleReplies(200);
    await caught(() => realGenerate.call(client, payload));
    expect("an account that answers again is no longer disabled", isAccountDisabled(EMAIL), false);
    expect("a verification flag also makes the pool skip", (flagVerification(EMAIL), isAccountRefused(EMAIL)), true);
    clearVerification(EMAIL);
    expect("guidance for a disabled account names the appeal, not a login", /appeal/i.test(refusalRecovery(DISABLED)) && !/re-login/i.test(refusalRecovery(DISABLED)), true);
    expect("guidance for a challenge names Re-login", /Re-login/.test(refusalRecovery(VERIFY)), true);
  } finally {
    (globalThis as any).fetch = realFetch;
  }

  console.log("\n[3/6] Re-login clears the flag and replaces the account in place ...");
  flagVerification(EMAIL);
  OAuthManager.getInstance().saveAccount({
    email: EMAIL,
    accessToken: "new-access",
    refreshToken: "refresh-0",
    expiresAt: Date.now() + 3_600_000,
    projectId: "p",
  } as any);
  expect("re-login clears the flag", isVerificationFlagged(EMAIL), false);
  expect("re-login upserts, it does not duplicate the card", JSON.parse(accountsContent).accounts.length, 1);

  // The flag is keyed by email, so removing the account must take its flag with it.
  flagVerification(EMAIL);
  expect("the account is removed", OAuthManager.getInstance().deleteAccountByEmail(EMAIL), true);
  expect("removing an account clears its flag", isVerificationFlagged(EMAIL), false);

  console.log("\n[4/6] /api/pool tells the page which account needs verification ...");
  flagVerification(EMAIL);
  const pool: any = OAuthManager.getInstance().getPoolStatus();
  const flagged = pool.accounts.find((a: any) => a.email === EMAIL);
  const other = pool.accounts.find((a: any) => a.email === OTHER);
  expect("the flagged account says so", flagged?.needsVerification, true);
  expect("the other account does not", other?.needsVerification, false);
  expect("the one-word status is unchanged", flagged?.status, "active");
  clearVerification(EMAIL);
  const cleared: any = OAuthManager.getInstance().getPoolStatus();
  expect("the field follows the flag", cleared.accounts.find((a: any) => a.email === EMAIL)?.needsVerification, false);
  flagDisabled(EMAIL);
  const withDisabled: any = OAuthManager.getInstance().getPoolStatus();
  expect("a disabled account says so", withDisabled.accounts.find((a: any) => a.email === EMAIL)?.disabledByGoogle, true);
  expect("without claiming verification", withDisabled.accounts.find((a: any) => a.email === EMAIL)?.needsVerification, false);
  expect("the other account is not disabled", withDisabled.accounts.find((a: any) => a.email === OTHER)?.disabledByGoogle, false);
  clearVerification(EMAIL);

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  try {
    console.log("\n[5/6] The consent URL can preselect the account being re-logged in ...");
    const oauth = OAuthManager.getInstance();
    const hinted = realGetWebOAuthUrl.call(oauth, EMAIL);
    expect("login_hint names the account", new URL(hinted).searchParams.get("login_hint"), EMAIL);
    const plain = realGetWebOAuthUrl.call(oauth);
    expect("no email means no hint", new URL(plain).searchParams.get("login_hint"), null);
    // The flow binds a real callback listener; close it so the suite can exit.
    (oauth as any).activeOAuthServer?.close();

    let seenHint: unknown = "unset";
    (OAuthManager.prototype as any).getWebOAuthUrl = (hint?: string) => {
      seenHint = hint ?? null;
      return "https://accounts.google.com/o/oauth2/v2/auth?response_type=code";
    };
    const authUrl = `http://127.0.0.1:${TEST_PORT}/api/pool/auth-url`;
    const withEmail = await fetch(`${authUrl}?email=${encodeURIComponent(EMAIL)}`, { redirect: "manual" });
    expect("auth-url still redirects to Google", withEmail.status, 302);
    expect("the card's email reaches the consent URL", seenHint, EMAIL);
    const withoutEmail = await fetch(authUrl, { redirect: "manual" });
    expect("Add Account keeps working with no email", withoutEmail.status, 302);
    expect("no email passes no hint", seenHint, null);

    // A browser navigation cannot send the API key header, so the dashboard asks for
    // JSON and opens the consent URL itself. Without this variant a key-protected
    // remote install answers 401 to a Re-login link.
    const asJson = await fetch(`${authUrl}?email=${encodeURIComponent(EMAIL)}`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    expect("the JSON variant answers 200, not a redirect", asJson.status, 200);
    const jsonText = await asJson.text();
    let jsonBody: any = null;
    try {
      jsonBody = JSON.parse(jsonText);
    } catch {
      jsonBody = null;
    }
    expect("it carries the consent URL", jsonBody?.url, "https://accounts.google.com/o/oauth2/v2/auth?response_type=code");
    expect("and still passes the hint", seenHint, EMAIL);

    // The reported bug: a key-protected install answered 401 to the Re-login link.
    // A forwarding header revokes loopback trust, so the key is genuinely required.
    process.env.BRIDGE_API_KEY = "test-key-not-a-real-secret";
    try {
      const remote = { "x-forwarded-for": "203.0.113.9", Accept: "application/json" };
      const noKey = await fetch(`${authUrl}?email=${encodeURIComponent(EMAIL)}`, { headers: remote, redirect: "manual" });
      expect("a keyless remote caller is refused", noKey.status, 401);
      const withKey = await fetch(`${authUrl}?email=${encodeURIComponent(EMAIL)}`, {
        headers: { ...remote, "x-api-key": "test-key-not-a-real-secret" },
        redirect: "manual",
      });
      expect("the same caller with the key gets the JSON URL", withKey.status, 200);
      const keyedBody: any = await withKey.json().catch(() => null);
      expect("and it is the consent URL", typeof keyedBody?.url, "string");
    } finally {
      delete process.env.BRIDGE_API_KEY;
    }
    (OAuthManager.prototype as any).getWebOAuthUrl = realGetWebOAuthUrl;

    console.log("\n[6/6] The 403 reply and the card both point at the page, not a terminal ...");
    (AntigravityClient.prototype as any).generateContent = async () => {
      throw new UpstreamError(403, `Antigravity https://example.invalid (403): ${VERIFY}`);
    };
    const denied = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-tiered",
        max_tokens: 16,
        messages: [{ role: "user", content: "x" }],
      }),
    });
    const deniedJson: any = await denied.json();
    expect("the reply is still a 403", denied.status, 403);
    expect("it keeps Google's own words", String(deniedJson?.error?.message).includes(VERIFY), true);
    expect("it names the dashboard", /dashboard/i.test(String(deniedJson?.error?.message)), true);
    expect("it does not send the caller to a CLI", /npm run/.test(String(deniedJson?.error?.message)), false);

    // A 403 that is not the verification challenge must not tell the caller to go
    // and verify anything: it is still a refused account, but a different reason.
    (AntigravityClient.prototype as any).generateContent = async () => {
      throw new UpstreamError(403, "Antigravity https://example.invalid (403): Permission denied on the requested project.");
    };
    const plainDenied = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-tiered",
        max_tokens: 16,
        messages: [{ role: "user", content: "x" }],
      }),
    });
    const plainJson: any = await plainDenied.json();
    expect("a plain permission 403 is still a 403", plainDenied.status, 403);
    expect("and still permission_error", plainJson?.error?.type, "permission_error");
    expect("it keeps Google's own words", String(plainJson?.error?.message).includes("Permission denied"), true);
    expect("it does not claim a verification prompt", /verification prompt/i.test(String(plainJson?.error?.message)), false);
    (AntigravityClient.prototype as any).generateContent = realGenerate;

    const html = realReadFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf-8") as string;
    let ui: any = null;
    try {
      ui = pageFunctions(html, ["verificationBadge", "reloginButton"]);
    } catch {
      ui = null;
    }
    expect("the page has a badge and a Re-login helper", ui !== null, true);
    if (ui) {
      expect("no badge on an account that is fine", ui.verificationBadge({ needsVerification: false }), "");
      expect("a flagged account gets a badge", String(ui.verificationBadge({ needsVerification: true })).includes("Verification needed"), true);
      const disabledBadge = String(ui.verificationBadge({ disabledByGoogle: true }));
      expect("a disabled account gets its own badge", disabledBadge.includes("Disabled by Google"), true);
      expect("which does not promise that Re-login helps", /Re-login/.test(disabledBadge), false);
      const btn = String(ui.reloginButton({ email: "a+tag@example.com" }));
      expect("the button goes through the keyed fetch handler", btn.includes("reloginAccount("), true);
      expect("it names that account", btn.includes("a+tag@example.com"), true);
      expect("it is a button, not a keyless link", btn.includes("<button"), true);
      expect("no bare href that would drop the API key", btn.includes("href="), false);
      expect("it says Re-login", btn.includes("Re-login"), true);
    }

    // The handler itself: the key must ride along via apiFetch, and the tab must be
    // opened before the await so a popup blocker still sees the user gesture.
    let reloginSrc = "";
    try {
      reloginSrc = pageFunctionSource(html, "reloginAccount");
    } catch {
      reloginSrc = "";
    }
    expect("the page has a reloginAccount handler", reloginSrc !== "", true);
    if (reloginSrc) {
      const makeRelogin = (deps: any) =>
        new Function("window", "apiFetch", "alert", "openPasteRedirectModal", `${reloginSrc}\nreturn reloginAccount;`)(
          deps.window,
          deps.apiFetch,
          deps.alert,
          deps.openPasteRedirectModal || (() => {})
        );
      const calls: Array<{ path: string; accept: unknown }> = [];
      const tab: any = { location: null, closed: false, close() { this.closed = true; } };
      const alerts: string[] = [];
      const reloginOk = makeRelogin({
        window: { open: () => tab, location: { hostname: "bridge.example" } },
        apiFetch: async (p: string, opts: any) => {
          calls.push({ path: p, accept: opts?.headers?.Accept });
          return { ok: true, status: 200, json: async () => ({ url: "https://accounts.google.com/consent" }) };
        },
        alert: (m: string) => alerts.push(m),
      });
      await reloginOk("a+tag@example.com");
      expect("re-login asks for the JSON variant", calls[0]?.accept, "application/json");
      expect("it encodes the account email", calls[0]?.path, "/api/pool/auth-url?email=a%2Btag%40example.com");
      expect("the opened tab lands on the consent URL", tab.location, "https://accounts.google.com/consent");
      expect("no error alert on success", alerts.length, 0);

      const badTab: any = { location: null, closed: false, close() { this.closed = true; } };
      const badAlerts: string[] = [];
      const reloginBad = makeRelogin({
        window: { open: () => badTab, location: { hostname: "bridge.example" } },
        apiFetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
        alert: (m: string) => badAlerts.push(m),
      });
      await reloginBad("a@example.com");
      expect("a refused fetch closes the blank tab", badTab.closed, true);
      expect("and tells the operator instead of failing silently", badAlerts.length, 1);
    }
    expect("the header Add Account no longer navigates keyless", html.includes('href="/api/pool/auth-url"'), false);
    const card = pageFunctionSource(html, "renderStitchDashboard");
    expect("the card draws the badge", card.includes("verificationBadge(acc)"), true);
    expect("the card draws the Re-login button", card.includes("reloginButton(acc)"), true);

    if (failures > 0) {
      throw new Error(`${failures} account-verification check(s) failed`);
    }
    console.log("\n=================================================");
    console.log(" 🎉 ALL ACCOUNT-VERIFICATION CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    (AntigravityClient.prototype as any).generateContent = realGenerate;
    (AntigravityClient.prototype as any).streamGenerateContent = realStream;
    (OAuthManager.prototype as any).getWebOAuthUrl = realGetWebOAuthUrl;
    (fs as any).existsSync = realExistsSync;
    (fs as any).readFileSync = realReadFileSync;
    (fs as any).writeFileSync = realWriteFileSync;
    (fs as any).chmodSync = realChmodSync;
    (fs as any).statSync = realStatSync;
    (fs as any).realpathSync = realRealpathSync;
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
