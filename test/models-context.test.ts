/**
 * Regression guard for what `/v1/models` tells a client about each model's size.
 *
 * The list used to carry only an id and a few constants. A client that sizes its
 * own prompt from the model list therefore learned nothing, and fell back to a
 * guess: Onyx (an OpenAI-compatible client) reads `context_length` from each
 * entry and, when it is absent and the id is not in its own catalogue, assumes
 * 32,000 tokens. A 54,000-token prompt for a model with a 1,048,576-token window
 * was refused in the client — "Not enough tokens … Available: 27201" — before a
 * byte reached the bridge, so nothing in the bridge's own logs said why.
 *
 * Every entry now carries `context_length`, taken from `SUPPORTED_MODELS` (itself
 * Google's metadata), the one field name OpenAI-compatible clients agree on.
 * The fields that were already there are unchanged.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import { SUPPORTED_MODELS } from "../src/constants";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { UsageTracker } from "../src/usage-tracker";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52145;

// No real account, tracker file or usage file is touched.
(OAuthManager.prototype as any).loadSavedAccount = () => ({ email: "a@example.com", projectId: "p", refreshToken: "r" });
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => false;
(OAuthManager.prototype as any).selectNextAvailableAccount = () => null;
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {};
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

async function listModels(path: string): Promise<{ status: number; data: any[] }> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`);
  const body: any = await res.json();
  return { status: res.status, data: Array.isArray(body?.data) ? body.data : [] };
}

async function runTests() {
  console.log("=================================================");
  console.log(" /v1/models advertises each model's context size");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();

  try {
    console.log("[1/4] Every model carries context_length, from the model table ...");
    const listed = await listModels("/v1/models");
    expect("status", listed.status, 200);
    expect("one entry per supported model", listed.data.length, SUPPORTED_MODELS.length);
    for (const def of SUPPORTED_MODELS) {
      const entry = listed.data.find((m) => m.id === def.id);
      expect(`${def.id}: context_length`, entry?.context_length, def.contextLimit);
    }

    console.log("\n[2/4] The value is a usable size, not a placeholder ...");
    const tiered = listed.data.find((m) => m.id === "gemini-3.8-flash-tiered");
    expect("gemini-3.8-flash-tiered is the 1M window", tiered?.context_length, 1048576);
    expect(
      "every context_length is a positive integer",
      listed.data.every((m) => Number.isInteger(m.context_length) && m.context_length > 0),
      true
    );

    console.log("\n[3/4] The fields that were already there are unchanged ...");
    expect("object", tiered?.object, "model");
    expect("owned_by", tiered?.owned_by, "google-antigravity");
    expect("root", tiered?.root, "gemini-3.8-flash-tiered");
    expect("parent", tiered?.parent, null);
    expect("created", tiered?.created, 1786800000);
    expect("permission", Array.isArray(tiered?.permission) && tiered.permission.length === 0, true);

    console.log("\n[4/4] The /models alias answers the same ...");
    const alias = await listModels("/models");
    expect("alias status", alias.status, 200);
    expect(
      "alias carries the same context_length for every model",
      alias.data.every((m) => m.context_length === listed.data.find((o) => o.id === m.id)?.context_length),
      true
    );

    if (failures > 0) {
      throw new Error(`${failures} models-context check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL MODELS-CONTEXT CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
