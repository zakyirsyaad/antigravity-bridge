/**
 * Regression guard for a connection to Google that fails before any byte is sent.
 *
 * The VPS has no IPv6 route, so of the two addresses Google's host resolves to only
 * IPv4 can connect. Node tries them in turn (happy eyeballs) and gives every address
 * but the last 250 ms. When DNS listed IPv4 first, a moment of slowness was enough:
 * IPv4 was abandoned at 250 ms, IPv6 failed at once, and the request ended as
 * `fetch failed` (AggregateError ETIMEDOUT). The in-place retries waited 1 s and 2 s,
 * all inside the same blip, so FCC received a 500 four seconds later.
 *
 * Now `BridgeServer.start()` gives each address 2 s (BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS),
 * and an error that arrives quickly is retried after 2 s and then 5 s. A request that
 * timed out waiting for Google keeps its old short pause: it has already waited.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { BridgeServer } from "../src/server";
import { USER_HOME } from "../src/constants";
import { connectAttemptTimeoutMs, networkRetryDelayMs } from "../src/network";

const TEST_PORT = 52147;
const ZCODE_DIR = path.join(USER_HOME, ".zcode");
const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
let stateWrites = 0;
const isState = (p: unknown) => String(p).startsWith(ZCODE_DIR);
(fs as any).existsSync = (p: any) => (isState(p) ? false : realExistsSync(p));
(fs as any).readFileSync = (p: any, ...rest: any[]) => (isState(p) ? "{}" : (realReadFileSync as any)(p, ...rest));
(fs as any).writeFileSync = (p: any, data: any, ...rest: any[]) => {
  if (isState(p)) {
    stateWrites++;
    return;
  }
  return (realWriteFileSync as any)(p, data, ...rest);
};

const ACCOUNT = { email: "a@example.com", projectId: "p", refreshToken: "r" };
let attempts = 0;
let respond: (attempt: number, init: any) => Promise<Response> | Response = () => ok();

(OAuthManager.prototype as any).loadSavedAccount = () => ACCOUNT;
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => false;
(OAuthManager.prototype as any).listAccounts = () => ({ accounts: [ACCOUNT], activeIndex: 0 });
(OAuthManager.prototype as any).selectNextAvailableAccount = () => null;
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {};

(globalThis as any).fetch = async (_url: string, init: any) => {
  attempts++;
  return respond(attempts, init);
};

function ok(): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
}
/** What undici throws when no address of the host could be connected to. */
function connectFailure(): Error {
  const cause = Object.assign(new AggregateError([new Error("timeout"), new Error("unreachable")]), { code: "ETIMEDOUT" });
  return Object.assign(new TypeError("fetch failed"), { cause });
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

async function timed(call: () => Promise<any>): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  try {
    const res: any = await call();
    return { text: res?.candidates?.[0]?.content?.parts?.[0]?.text || "", ms: Date.now() - started };
  } catch (e: any) {
    return { text: `THREW ${e.message}`, ms: Date.now() - started };
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" A connection that fails quickly is given time");
  console.log("=================================================\n");

  console.log("[1/5] The per-address connect timeout is 2 s unless configured ...");
  delete process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS;
  expect("the default is 2000 ms", connectAttemptTimeoutMs(), 2000);
  process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS = "3500";
  expect("an env value overrides it", connectAttemptTimeoutMs(), 3500);
  process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS = "junk";
  expect("a junk value falls back to the default", connectAttemptTimeoutMs(), 2000);
  process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS = "-5";
  expect("a negative value falls back to the default", connectAttemptTimeoutMs(), 2000);

  console.log("\n[2/5] Starting the server applies it to every connection Node opens ...");
  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS = "1234";
  process.env.BRIDGE_HOST = "127.0.0.1";
  const server = new BridgeServer(TEST_PORT);
  await server.start();
  expect("Node's default after start()", net.getDefaultAutoSelectFamilyAttemptTimeout(), 1234);
  await server.stop();
  delete process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS;

  console.log("\n[3/5] Quick network errors are retried after 2 s, then 5 s ...");
  expect("before the second attempt", networkRetryDelayMs(1), 2000);
  expect("before the third attempt", networkRetryDelayMs(2), 5000);
  expect("never longer than that", networkRetryDelayMs(7), 5000);

  console.log("\n[4/5] A connect failure that clears up is waited out, on the same account ...");
  const client = new AntigravityClient();
  attempts = 0;
  respond = (n) => {
    if (n === 1) throw connectFailure();
    return ok();
  };
  const recovered = await timed(() => client.generateContent(payload as any));
  expect("the request succeeds", recovered.text, "ok");
  expect("after exactly one retry", attempts, 2);
  expect("having waited at least the first pause", recovered.ms >= 1900, true);

  console.log("\n[5/5] A request that timed out waiting for Google keeps its short pause ...");
  process.env.BRIDGE_UPSTREAM_TIMEOUT_MS = "30";
  attempts = 0;
  respond = (n, init) => (n === 1 ? hang(init) : ok());
  const afterStall = await timed(() => client.generateContent(payload as any));
  expect("the request succeeds", afterStall.text, "ok");
  expect("after exactly one retry", attempts, 2);
  expect("with the old 1 s pause, not the new 2 s one", afterStall.ms < 1800, true);
  delete process.env.BRIDGE_UPSTREAM_TIMEOUT_MS;

  expect("nothing was written to ~/.zcode", stateWrites, 0);

  if (failures > 0) {
    throw new Error(`${failures} network-retry check(s) failed`);
  }
}

runTests()
  .then(() => {
    console.log("\n=================================================");
    console.log(" 🎉 ALL NETWORK RETRY CHECKS PASSED!");
    console.log("=================================================\n");
  })
  .catch((e) => {
    console.error("Test failed with error:", e.message);
    process.exit(1);
  });
