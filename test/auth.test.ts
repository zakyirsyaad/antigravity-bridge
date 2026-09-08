/**
 * Regression guard for management/inference authentication.
 *
 * The bridge is deployed on a public host, so before this every route was open
 * to the internet: anyone who knew the URL could read the pool, delete accounts
 * via POST /api/pool/delete, or spend the pooled Google quota through
 * /v1/chat/completions. The origin check added earlier only stops browsers — a
 * plain curl sends no Origin header and sailed straight through.
 *
 * Loopback stays trusted so the dashboard and CLI need no configuration;
 * BRIDGE_TRUST_LOCAL=0 lifts that, which is also how this suite simulates a
 * remote caller without binding a non-loopback address.
 *
 * Everything is stubbed: no disk, no network, no credential, no quota.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52142;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const KEY = "correct-horse-battery-staple";

(OAuthManager.prototype as any).listAccounts = () => ({ accounts: [], activeIndex: 0 });
(OAuthManager.prototype as any).loadSavedAccount = () => null;
(AntigravityClient.prototype as any).generateContent = async () => ({
  candidates: [{ content: { parts: [{ text: "ok" }] } }],
});

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function status(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(`${BASE}${path}`, init);
  await res.text();
  return res.status;
}

/** Pretend the caller is remote: loopback is trusted unless this is off. */
function asRemote(fn: () => Promise<void>): Promise<void> {
  process.env.BRIDGE_TRUST_LOCAL = "0";
  return fn().finally(() => {
    delete process.env.BRIDGE_TRUST_LOCAL;
  });
}

async function runTests() {
  console.log("=================================================");
  console.log(" Bridge authentication regression");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT}\n`);

  try {
    console.log("[1/7] Loopback is trusted by default, no key needed ...");
    delete process.env.BRIDGE_API_KEY;
    expect("GET /api/pool", await status("/api/pool"), 200);

    console.log("\n[1b/7] A proxied request is NOT treated as local ...");
    // nginx and friends proxy from 127.0.0.1, so the socket address says
    // loopback for every caller on the internet. The forwarding headers are the
    // only thing distinguishing them.
    delete process.env.BRIDGE_API_KEY;
    expect("X-Forwarded-For, no key", await status("/api/pool", { headers: { "X-Forwarded-For": "203.0.113.7" } }), 401);
    expect("X-Real-IP, no key", await status("/api/pool", { headers: { "X-Real-IP": "203.0.113.7" } }), 401);
    process.env.BRIDGE_API_KEY = KEY;
    expect("proxied with the key", await status("/api/pool", { headers: { "X-Forwarded-For": "203.0.113.7", "x-api-key": KEY } }), 200);
    expect("proxied, wrong key", await status("/api/pool", { headers: { "X-Forwarded-For": "203.0.113.7", "x-api-key": "no" } }), 401);
    delete process.env.BRIDGE_API_KEY;

    await asRemote(async () => {
      console.log("\n[2/7] Remote caller with BRIDGE_API_KEY unset is refused ...");
      delete process.env.BRIDGE_API_KEY;
      expect("GET /api/pool", await status("/api/pool"), 401);
      expect("POST /api/pool/delete", await status("/api/pool/delete", { method: "POST", body: "{}" }), 401);

      console.log("\n[3/7] Remote caller with no or wrong key is refused ...");
      process.env.BRIDGE_API_KEY = KEY;
      expect("no key", await status("/api/pool"), 401);
      expect("wrong key", await status("/api/pool", { headers: { "x-api-key": "nope" } }), 401);

      console.log("\n[4/7] Remote caller with the right key is served ...");
      expect("x-api-key", await status("/api/pool", { headers: { "x-api-key": KEY } }), 200);
      expect("Authorization: Bearer", await status("/api/pool", { headers: { Authorization: `Bearer ${KEY}` } }), 200);

      console.log("\n[5/7] Inference endpoints are protected too ...");
      const body = JSON.stringify({ model: "gemini-3-flash", messages: [{ role: "user", content: "x" }] });
      const json = { "Content-Type": "application/json" };
      expect("no key", await status("/v1/chat/completions", { method: "POST", headers: json, body }), 401);
      expect("no key", await status("/v1/messages", { method: "POST", headers: json, body }), 401);
      expect(
        "with key",
        await status("/v1/chat/completions", {
          method: "POST",
          headers: { ...json, "x-api-key": KEY },
          body,
        }),
        200
      );

      console.log("\n[6/7] Dashboard shell loads so it can ask for a key ...");
      expect("GET / (html)", await status("/", { headers: { Accept: "text/html" } }), 200);
      expect("GET / (json variant)", await status("/", { headers: { Accept: "application/json" } }), 401);
      expect("OPTIONS preflight", await status("/api/pool", { method: "OPTIONS" }), 204);
    });

    if (failures > 0) {
      throw new Error(`${failures} authentication check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL AUTHENTICATION CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    delete process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_TRUST_LOCAL;
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
