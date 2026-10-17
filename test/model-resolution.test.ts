/**
 * Regression guard for model id resolution.
 *
 * resolveModel() guesses when an id is not an exact match, and it has to: Claude
 * Code sends Anthropic's own model names, which have to land somewhere. But the
 * guessing used to be silent, so `gemini-3.8-flash-tiered-high` — the shape a
 * client produces when it appends a reasoning suffix to a model name — quietly
 * became a different model generation, and a name that matched nothing at all
 * was forwarded to Google to die as an opaque "invalid argument" 400.
 *
 * Both are now visible: inexact matches warn once, and an unmappable id is a
 * 400 from the bridge naming what to use instead.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { BridgeServer } from "../src/server";
import { Transformer, UnknownModelError } from "../src/transformer";
import { SUPPORTED_MODELS } from "../src/constants";

const TEST_PORT = 52143;

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

function resolve(id: string): string {
  try {
    return Transformer.resolveModel(id);
  } catch (e: any) {
    return e instanceof UnknownModelError ? "THREW UnknownModelError" : `THREW ${e.name}`;
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" Model id resolution regression");
  console.log("=================================================\n");

  console.log("[1/4] Exact ids pass through untouched ...");
  expect("tiered", resolve("gemini-3.8-flash-tiered"), "gemini-3.8-flash-tiered");
  expect("3.5 flash lite", resolve("gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  expect("3.1 flash lite", resolve("gemini-3.1-flash-lite"), "gemini-3.1-flash-lite");
  expect("claude opus", resolve("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
  expect("the display name still resolves", resolve("Gemini 3.5 Flash Lite"), "gemini-3.5-flash-lite");

  console.log("\n[2/4] Retired ids resolve to what their name claimed ...");
  expect("gemini-3.8-flash", resolve("gemini-3.8-flash"), "gemini-3.8-flash-tiered");
  // No Gemini Pro is served: gemini-pro-agent and gemini-3.1-pro-low answer 404, gemini-3.1-pro-high
  // 400, gemini-2.5-pro 503 "no capacity" on every account. A pro request gets the most capable
  // Gemini that answers.
  for (const pro of ["gemini-3-pro", "gemini-3.1-pro", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-pro-agent", "gemini-2.5-pro"]) {
    expect(pro, resolve(pro), "gemini-3.8-flash-tiered");
  }
  // Google answers 404 for these tiered ids; the newest tiered model is the closest living one.
  expect("gemini-3.7-flash-tiered", resolve("gemini-3.7-flash-tiered"), "gemini-3.8-flash-tiered");
  expect("gemini-3.6-flash-tiered", resolve("gemini-3.6-flash-tiered"), "gemini-3.8-flash-tiered");
  expect("gemini-3.7-flash", resolve("gemini-3.7-flash"), "gemini-3.8-flash-tiered");
  expect("gemini-3.7-flash-high", resolve("gemini-3.7-flash-high"), "gemini-3.8-flash-tiered");
  // The fixed 3.6 tiers answer 404; the 3.5 tiers answer 200 with a canned "no longer
  // available" sentence instead of a reply. reasoning_effort recovers the tier.
  for (const fixed of ["gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low", "gemini-3-flash-agent", "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low"]) {
    expect(fixed, resolve(fixed), "gemini-3.8-flash-tiered");
  }
  // Google lists all three under the display name "Gemini 3.5 Flash Lite".
  for (const lite of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking"]) {
    expect(lite, resolve(lite), "gemini-3.5-flash-lite");
  }
  expect("a nearest-match for a pro name lands on the most capable living Gemini", resolve("some-pro-model"), "gemini-3.8-flash-tiered");
  expect("a nearest-match for a lite name lands on the newest lite", resolve("gemini-9-flash-lite"), "gemini-3.5-flash-lite");
  const exposed = new Set(SUPPORTED_MODELS.map((m) => m.id));
  const retired = (Transformer as any).RETIRED_IDS as Record<string, string>;
  for (const [dead, target] of Object.entries(retired)) {
    expect(`${dead} is no longer exposed`, exposed.has(dead), false);
    // An alias onto another alias, or onto nothing, would hand the client a dead model again.
    expect(`${dead} points at an exposed model`, exposed.has(target), true);
  }
  expect("a model Google serves has not been dropped", exposed.has("gemini-3.8-flash-tiered") && exposed.has("gemini-3-flash"), true);

  console.log("\n[3/4] Near-misses still resolve, rather than failing a real client ...");
  // Claude Code sends Anthropic's own ids; refusing them would break the
  // primary use case, so these are approximated — but no longer silently.
  expect("anthropic sonnet id", resolve("claude-sonnet-4-5-20250929"), "claude-sonnet-4-6");
  // The shape that used to change generation without a word. The flash guess is the
  // newest flash now, so it lands where the caller meant, but it still warns.
  expect("model+reasoning suffix", resolve("gemini-3.8-flash-tiered-high"), "gemini-3.8-flash-tiered");
  expect("every guess is a model that is exposed", ["claude-opus-x", "claude-sonnet-x", "x-pro", "x-lite", "gemini-x"].every((id) => exposed.has(resolve(id))), true);

  console.log("\n[3b/4] A routing prefix is not part of the model name ...");
  // OpenCode / OpenRouter-style clients write `provider/model`. The tail is an exact
  // id, so guessing from the whole string landed on gemini-3.6-flash-high — a
  // different model generation, with only a once-per-process warning to say so.
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: any[]) => {
    warned.push(a.map(String).join(" "));
  };
  const prefixed = {
    custom: resolve("open-design-byok/gemini-3.8-flash-tiered"),
    nested: resolve("openrouter/google/gemini-3.8-flash-tiered"),
    claude: resolve("anthropic/claude-sonnet-4-6"),
    mixedCase: resolve("Open-Design-BYOK/Gemini-3.8-Flash-Tiered"),
    retiredTail: resolve("openrouter/gemini-3.8-flash"),
    unknownTail: resolve("someprovider/totally-made-up"),
  };
  console.warn = realWarn;
  expect("custom provider prefix", prefixed.custom, "gemini-3.8-flash-tiered");
  expect("two-level prefix", prefixed.nested, "gemini-3.8-flash-tiered");
  expect("claude with a prefix", prefixed.claude, "claude-sonnet-4-6");
  expect("prefix is case-insensitive", prefixed.mixedCase, "gemini-3.8-flash-tiered");
  expect("a retired tail still maps to what it claimed", prefixed.retiredTail, "gemini-3.8-flash-tiered");
  expect("an unknown tail is still rejected", prefixed.unknownTail, "THREW UnknownModelError");
  expect("stripping a prefix is not a guess, so it does not warn about approximating", warned.some((w) => w.includes("approximated")), false);

  console.log("\n[4/4] An unmappable id is rejected here, not by Google ...");
  expect("gpt-4o", resolve("gpt-4o"), "THREW UnknownModelError");
  expect("nonsense", resolve("totally-made-up"), "THREW UnknownModelError");

  let message = "";
  try {
    Transformer.resolveModel("totally-made-up");
  } catch (e: any) {
    message = e.message;
  }
  expect("message names the bad id", message.includes("totally-made-up"), true);
  expect("message lists valid ids", message.includes("gemini-3.8-flash-tiered"), true);

  console.log("\n[+] The server reports it as 400, not 500 ...");
  const server = new BridgeServer(TEST_PORT);
  await server.start();
  try {
    const post = async (path: string, model: string) => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }] }),
      });
      const body: any = await res.json().catch(() => ({}));
      return { status: res.status, type: body?.error?.type };
    };

    const openai = await post("/v1/chat/completions", "gpt-4o");
    expect("OpenAI status", openai.status, 400);
    expect("OpenAI error type", openai.type, "invalid_request_error");

    const anthropic = await post("/v1/messages", "gpt-4o");
    expect("Anthropic status", anthropic.status, 400);

    const good = await post("/v1/chat/completions", "gemini-3.8-flash-tiered");
    expect("a valid model still succeeds", good.status, 200);

    if (failures > 0) {
      throw new Error(`${failures} model resolution check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL MODEL RESOLUTION CHECKS PASSED!");
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
