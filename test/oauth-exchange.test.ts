/**
 * Completing a browser OAuth login from a machine that is not the bridge.
 *
 * Google's redirect_uri is fixed to http://localhost:51121/oauth-callback, so on a
 * remote install the operator's browser lands on a page that cannot load and the
 * authorization code never reaches the bridge's listener. The dashboard therefore
 * offers a paste box: the operator copies the dead tab's address bar and the page
 * posts it to /oauth/exchange, which parses the code and the PKCE verifier out of
 * the state parameter and finishes the exchange itself.
 *
 * Two defects are guarded here: the exchange used to omit code_verifier entirely
 * (Google rejects a PKCE code without it), and re-logging an existing non-active
 * account used to hijack the active slot.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import path from "node:path";
import { pageFunctionSource } from "./dashboard-functions";
import { OAuthManager } from "../src/oauth";
import { BridgeServer } from "../src/server";
import { ACCOUNTS_STORAGE_PATH } from "../src/constants";

const TEST_PORT = 52156;
const A = "a@example.com";
const B = "b@example.com";
const C = "c@example.com";

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
const realChmodSync = fs.chmodSync;
const realStatSync = fs.statSync;
const realRealpathSync = fs.realpathSync;

let accountsContent = JSON.stringify({
  accounts: [
    { email: A, accessToken: "old-a", refreshToken: "r-a", expiresAt: Date.now() + 3_600_000, projectId: "p" },
    { email: B, accessToken: "old-b", refreshToken: "r-b", expiresAt: Date.now() + 3_600_000, projectId: "p" },
  ],
  activeAccountIndex: 0,
});
const isAccounts = (p: unknown) => String(p) === ACCOUNTS_STORAGE_PATH;
(fs as any).existsSync = (p: any) => (isAccounts(p) ? true : realExistsSync(p));
(fs as any).readFileSync = (p: any, ...rest: any[]) =>
  isAccounts(p) ? accountsContent : (realReadFileSync as any)(p, ...rest);
(fs as any).writeFileSync = (p: any, data: any, ...rest: any[]) => {
  if (isAccounts(p)) {
    accountsContent = String(data);
    return;
  }
  return (realWriteFileSync as any)(p, ...rest);
};
(fs as any).chmodSync = (p: any, ...rest: any[]) => (isAccounts(p) ? undefined : (realChmodSync as any)(p, ...rest));
(fs as any).statSync = (p: any, ...rest: any[]) => (isAccounts(p) ? { mode: 0o600 } : (realStatSync as any)(p, ...rest));
(fs as any).realpathSync = (p: any, ...rest: any[]) =>
  isAccounts(p) ? ACCOUNTS_STORAGE_PATH : (realRealpathSync as any)(p, ...rest);

/** What Google's userinfo will say next, so one suite can re-login B and then add C. */
let nextEmail = B;
/** Bodies posted to Google's token endpoint, to prove the verifier travels. */
const tokenBodies: string[] = [];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  // The suite's own requests to the test server must reach it, not the stub.
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, init);
  if (u.includes("oauth2.googleapis.com/token")) {
    tokenBodies.push(String(init?.body || ""));
    // Google issues a distinct refresh token per account; saveAccount dedupes on it.
    return new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt-" + nextEmail, expires_in: 3600 }),
      { status: 200 }
    );
  }
  if (u.includes("userinfo")) {
    return new Response(JSON.stringify({ email: nextEmail, name: "Name" }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
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

const stateOf = (verifier: string) => Buffer.from(JSON.stringify({ verifier })).toString("base64url");
const redirectUrlOf = (code: string, verifier: string) =>
  `http://localhost:51121/oauth-callback?state=${stateOf(verifier)}&iss=https://accounts.google.com&code=${code}&authuser=0`;

const storage = () => JSON.parse(accountsContent);

async function runTests() {
  console.log("=================================================");
  console.log(" A remote browser login can be finished by paste");
  console.log("=================================================\n");

  console.log("[1/5] The exchange carries the PKCE verifier ...");
  tokenBodies.length = 0;
  await OAuthManager.getInstance().exchangeAuthorizationCode("code-direct", "verifier-direct");
  expect("code_verifier is posted to Google", tokenBodies[0]?.includes("code_verifier=verifier-direct"), true);
  expect("and the code travels too", tokenBodies[0]?.includes("code=code-direct"), true);

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${TEST_PORT}/oauth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    console.log("\n[2/5] A pasted redirect URL finishes the login ...");
    tokenBodies.length = 0;
    nextEmail = B;
    const ok = await post({ redirectUrl: redirectUrlOf("code-pasted", "verifier-pasted") });
    expect("the paste is accepted", ok.status, 200);
    const okJson: any = await ok.json();
    expect("it names the account", okJson?.email, B);
    expect("the verifier came out of the state", tokenBodies[0]?.includes("code_verifier=verifier-pasted"), true);
    expect("the code came out of the query", tokenBodies[0]?.includes("code=code-pasted"), true);
    expect("the account's tokens were replaced", storage().accounts[1].accessToken, "at");

    console.log("\n[3/5] Re-logging an existing non-active account keeps the active slot ...");
    expect("active is still index 0", storage().activeAccountIndex, 0);
    expect("and still account A", storage().accounts[0].email, A);

    console.log("\n[4/5] A genuinely new account still becomes active, and bad input is refused ...");
    nextEmail = C;
    const added = await post({ redirectUrl: redirectUrlOf("code-new", "verifier-new") });
    expect("a new account is accepted", added.status, 200);
    const now = storage();
    expect("it was appended", now.accounts.length, 3);
    expect("and becomes active", now.accounts[now.activeAccountIndex].email, C);

    expect("no code at all is a 400", (await post({})).status, 400);
    expect("a code without a verifier is a 400", (await post({ code: "lonely" })).status, 400);
    const explicit = await post({ code: "code-explicit", codeVerifier: "verifier-explicit" });
    expect("code plus verifier also works", explicit.status, 200);

    console.log("\n[5/5] The dashboard offers the paste box and posts what was pasted ...");
    const html = realReadFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf-8") as string;
    expect("the paste modal exists", html.includes('id="pasteRedirectModal"'), true);
    expect("with a place to paste the URL", html.includes('id="pasteRedirectUrl"'), true);

    let reloginSrc = "";
    let submitSrc = "";
    try {
      reloginSrc = pageFunctionSource(html, "reloginAccount");
      submitSrc = pageFunctionSource(html, "submitPasteRedirect");
    } catch {
      reloginSrc = "";
      submitSrc = "";
    }
    expect("both handlers exist", reloginSrc !== "" && submitSrc !== "", true);
    if (reloginSrc && submitSrc) {
      const opened: string[] = [];
      const tab: any = { location: null, closed: false, close() { this.closed = true; } };
      const relogin = new Function(
        "window", "apiFetch", "alert", "openPasteRedirectModal",
        `${reloginSrc}\nreturn reloginAccount;`
      )(
        { open: () => tab, location: { hostname: "bridge.example" } },
        async () => ({ ok: true, status: 200, json: async () => ({ url: "https://accounts.google.com/consent" }) }),
        () => {},
        (email: string) => opened.push(email)
      );
      await relogin(B);
      expect("the consent tab still opens", tab.location, "https://accounts.google.com/consent");
      expect("and the paste box is offered for that account", opened[0], B);

      const localRelogin = new Function(
        "window", "apiFetch", "alert", "openPasteRedirectModal",
        `${reloginSrc}\nreturn reloginAccount;`
      )(
        { open: () => tab, location: { hostname: "localhost" } },
        async () => ({ ok: true, status: 200, json: async () => ({ url: "https://accounts.google.com/consent" }) }),
        () => {},
        (email: string) => opened.push(email)
      );
      await localRelogin(B);
      expect("a loopback dashboard needs no paste box", opened.length, 1);

      const posted: any[] = [];
      const nodes: Record<string, any> = {
        pasteRedirectUrl: { value: redirectUrlOf("code-ui", "verifier-ui") },
        pasteRedirectErrorMsg: { style: {}, textContent: "" },
        pasteRedirectSubmitBtn: { disabled: false, textContent: "" },
      };
      const submit = new Function(
        "document", "apiFetch", "alert", "fetchPoolStatus", "closePasteRedirectModal",
        `${submitSrc}\nreturn submitPasteRedirect;`
      )(
        { getElementById: (id: string) => nodes[id] },
        async (p: string, opts: any) => {
          posted.push({ path: p, body: JSON.parse(opts.body) });
          return { ok: true, status: 200, json: async () => ({ email: B }) };
        },
        () => {},
        () => {},
        () => {}
      );
      await submit();
      expect("it posts to the exchange endpoint", posted[0]?.path, "/oauth/exchange");
      expect("carrying the pasted URL verbatim", posted[0]?.body?.redirectUrl, redirectUrlOf("code-ui", "verifier-ui"));
    }

    if (failures > 0) throw new Error(`${failures} oauth-exchange check(s) failed`);
    console.log("\n=================================================");
    console.log(" 🎉 ALL OAUTH-EXCHANGE CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    (globalThis as any).fetch = realFetch;
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
