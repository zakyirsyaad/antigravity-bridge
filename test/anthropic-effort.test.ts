/**
 * Regression guard for reasoning effort on the Anthropic path.
 *
 * Claude Code sends `output_config.effort` (low | medium | high | xhigh | max)
 * on every request, plus `thinking: { type: "adaptive" }` with no token budget.
 * The bridge only read `thinking.budget_tokens`, so effort was dropped on the
 * floor: `/effort low` saved nothing, and the only knob a user had was the model
 * id. The OpenAI path already honoured `reasoning_effort`; this is the same idea
 * for the other protocol.
 *
 * The scale is anchored on each protocol's DEFAULT level, not on the words.
 * OpenAI's default is "medium", Anthropic's is "high" — Claude Code sends it
 * even when nobody chose anything. Mapping "high" to 4x, as the OpenAI path
 * does, would have quadrupled thinking spend on every fixed-budget model for
 * every user who simply upgraded. So the default level is 1x on both paths:
 * lower saves, higher spends, and doing nothing changes nothing.
 *
 * Pure transformation — no disk, network, credential or quota.
 */
import { Transformer } from "../src/transformer";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

const DYNAMIC = "gemini-3.8-flash-tiered"; // declared budget -1: sizes its own reasoning
const FIXED = "gemini-3.1-pro-high"; // declared budget 10001
const NO_THINKING = "gemini-3.1-flash-lite";

/** The thinking_budget that would actually reach Google, or undefined if none. */
function anthropicBudget(model: string, extra: Record<string, unknown> = {}): unknown {
  const payload: any = Transformer.anthropicToAntigravity({
    model,
    max_tokens: 64000, // roomy: this suite tests the mapping, not the max_tokens fit
    messages: [{ role: "user", content: "x" }],
    ...extra,
  });
  return payload.request.generationConfig.thinkingConfig?.thinking_budget;
}

function openaiBudget(model: string, extra: Record<string, unknown> = {}): unknown {
  const payload: any = Transformer.openaiToAntigravity({
    model,
    max_tokens: 64000,
    messages: [{ role: "user", content: "x" }],
    ...extra,
  });
  return payload.request.generationConfig.thinkingConfig?.thinking_budget;
}

const effort = (level: unknown) => ({ output_config: { effort: level }, thinking: { type: "adaptive" } });

function runTests() {
  console.log("=================================================");
  console.log(" Reasoning effort on the Anthropic path");
  console.log("=================================================\n");

  console.log("[1/6] A dynamic model: effort picks the tier ...");
  expect("no effort -> dynamic, as before", anthropicBudget(DYNAMIC), -1);
  expect("low", anthropicBudget(DYNAMIC, effort("low")), 1000);
  expect("medium", anthropicBudget(DYNAMIC, effort("medium")), 4000);
  expect("high (Claude Code's default) stays dynamic", anthropicBudget(DYNAMIC, effort("high")), -1);
  expect("xhigh", anthropicBudget(DYNAMIC, effort("xhigh")), -1);
  expect("max", anthropicBudget(DYNAMIC, effort("max")), -1);

  console.log("\n[2/6] A fixed-budget model: the default level changes nothing ...");
  expect("no effort -> declared budget, as before", anthropicBudget(FIXED), 10001);
  expect("high == declared, so an upgrade changes no spend", anthropicBudget(FIXED, effort("high")), 10001);
  expect("low is a quarter", anthropicBudget(FIXED, effort("low")), 2500);
  expect("medium is a half", anthropicBudget(FIXED, effort("medium")), 5001);
  expect("xhigh doubles", anthropicBudget(FIXED, effort("xhigh")), 20002);
  expect("max is four times", anthropicBudget(FIXED, effort("max")), 40004);

  console.log("\n[3/6] Explicit instructions outrank effort ...");
  expect(
    "thinking.budget_tokens wins over effort",
    anthropicBudget(DYNAMIC, { output_config: { effort: "low" }, thinking: { type: "enabled", budget_tokens: 7777 } }),
    7777
  );
  expect(
    "thinking disabled wins over effort",
    anthropicBudget(DYNAMIC, { output_config: { effort: "max" }, thinking: { type: "disabled" } }),
    0
  );
  expect(
    "an adaptive block alone is not a budget",
    anthropicBudget(FIXED, { thinking: { type: "adaptive" } }),
    10001
  );

  console.log("\n[4/6] Garbage is ignored rather than guessed at ...");
  expect("unknown level", anthropicBudget(FIXED, effort("ludicrous")), 10001);
  expect("non-string level", anthropicBudget(FIXED, effort(42)), 10001);
  expect("empty string", anthropicBudget(FIXED, effort("")), 10001);
  expect("effort in the wrong case still counts", anthropicBudget(DYNAMIC, effort("LOW")), 1000);
  expect("effort without any thinking block", anthropicBudget(DYNAMIC, { output_config: { effort: "low" } }), 1000);

  console.log("\n[5/6] A model that cannot think gets no thinking config ...");
  expect("effort on a non-thinking model", anthropicBudget(NO_THINKING, effort("max")), undefined);

  console.log("\n[6/6] The OpenAI path is untouched by sharing the helper ...");
  expect("dynamic, low", openaiBudget(DYNAMIC, { reasoning_effort: "low" }), 1000);
  expect("dynamic, medium", openaiBudget(DYNAMIC, { reasoning_effort: "medium" }), 4000);
  expect("dynamic, high", openaiBudget(DYNAMIC, { reasoning_effort: "high" }), -1);
  expect("fixed, medium is still 1x", openaiBudget(FIXED, { reasoning_effort: "medium" }), 10001);
  expect("fixed, high is still 4x", openaiBudget(FIXED, { reasoning_effort: "high" }), 40004);
  expect("fixed, low is still a quarter", openaiBudget(FIXED, { reasoning_effort: "low" }), 2500);
  expect("none disables thinking", openaiBudget(FIXED, { reasoning_effort: "none" }), 0);

  if (failures > 0) {
    throw new Error(`${failures} effort check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL EFFORT CHECKS PASSED!");
  console.log("=================================================\n");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
