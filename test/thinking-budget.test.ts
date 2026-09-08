/**
 * Regression guard for output-cap handling when thinking is enabled.
 *
 * Both request transformers used to raise maxOutputTokens to
 * `Math.max(64000, budget + 8192)` whenever the caller's cap was not larger
 * than the thinking budget. A client asking for `max_tokens: 100` therefore got
 * a 64000-token window — a 640x overshoot that silently discards an explicit
 * cost ceiling and burns pooled quota, which is the resource this whole project
 * exists to conserve.
 *
 * The intent was sound: thinking tokens count against maxOutputTokens, so the
 * budget must leave room for a visible answer. The fix is to shrink the budget
 * into the caller's cap rather than inflate the cap.
 *
 * Pure transformation — no server, no disk, no network, no quota.
 */
import { Transformer } from "../src/transformer";

/** Declared budget 10001, floor 128 — a fixed, generous budget. */
const PRO_HIGH = "gemini-3.1-pro-high";
/** Declared budget -1: the model sizes its own reasoning. */
const DYNAMIC = "gemini-3.6-flash-high";
/** No thinking support at all. */
const PLAIN = "gemini-3.1-flash-lite";
const MESSAGES = [{ role: "user", content: "hi" }];

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function anthropic(model: string, body: Record<string, any> = {}): any {
  return Transformer.anthropicToAntigravity({ model, messages: MESSAGES, ...body }).request.generationConfig;
}

function openai(model: string, body: Record<string, any> = {}): any {
  return Transformer.openaiToAntigravity({ model, messages: MESSAGES, ...body }).request.generationConfig;
}

function runTests() {
  console.log("=================================================");
  console.log(" Thinking budget vs. caller output cap");
  console.log("=================================================\n");

  console.log("[1/8] A small explicit cap is honoured, not inflated ...");
  const tiny = anthropic(PRO_HIGH, { max_tokens: 100 });
  expect("maxOutputTokens", tiny.maxOutputTokens, 100);
  expect("thinking disabled (no room for it)", tiny.thinkingConfig?.thinking_budget, 0);
  expect("include_thoughts", tiny.thinkingConfig?.include_thoughts, false);

  console.log("\n[2/8] A roomy cap keeps the model's declared budget ...");
  const roomy = anthropic(PRO_HIGH, { max_tokens: 64000 });
  expect("maxOutputTokens", roomy.maxOutputTokens, 64000);
  expect("thinking_budget", roomy.thinkingConfig?.thinking_budget, 10001);

  console.log("\n[3/8] A mid cap clamps the budget into the window ...");
  // 20000 - 8192 reserve = 11808 of room, so the declared 10001 still fits.
  expect("fits", anthropic(PRO_HIGH, { max_tokens: 20000 }).thinkingConfig?.thinking_budget, 10001);
  // 12000 - 6000 (reserve clamped to half) = 6000 of room, below the declared.
  const squeezed = anthropic(PRO_HIGH, { max_tokens: 12000 });
  expect("clamped to room", squeezed.thinkingConfig?.thinking_budget, 6000);

  console.log("\n[4/8] Per-model budgets differ, rather than one global number ...");
  expect("pro-low", anthropic("gemini-3.1-pro-low", { max_tokens: 64000 }).thinkingConfig?.thinking_budget, 1001);
  expect("claude opus", anthropic("claude-opus-4-6-thinking", { max_tokens: 64000 }).thinkingConfig?.thinking_budget, 1024);
  expect("flash medium", anthropic("gemini-3.6-flash-medium", { max_tokens: 64000 }).thinkingConfig?.thinking_budget, 4000);

  console.log("\n[5/8] A dynamic model keeps sizing its own reasoning ...");
  const dyn = anthropic(DYNAMIC, { max_tokens: 64000 });
  expect("thinking_budget", dyn.thinkingConfig?.thinking_budget, -1);
  expect("include_thoughts", dyn.thinkingConfig?.include_thoughts, true);
  const dynNoCap = anthropic(DYNAMIC);
  expect("still gets a default window", dynNoCap.maxOutputTokens, 64000);
  expect("still dynamic", dynNoCap.thinkingConfig?.thinking_budget, -1);
  // This model's floor is 32, so a 100-token window still has room (50). Only
  // below twice the floor does dynamic thinking actually get switched off.
  expect("still dynamic at 100", anthropic(DYNAMIC, { max_tokens: 100 }).thinkingConfig?.thinking_budget, -1);
  expect("no room -> disabled", anthropic(DYNAMIC, { max_tokens: 50 }).thinkingConfig?.thinking_budget, 0);

  console.log("\n[6/8] Explicit caller budgets and disabling still win ...");
  expect("explicit budget", anthropic(PRO_HIGH, { max_tokens: 64000, thinking: { budget_tokens: 2048 } }).thinkingConfig?.thinking_budget, 2048);
  expect("disabled", anthropic(PRO_HIGH, { max_tokens: 500, thinking: { type: "disabled" } }).thinkingConfig?.thinking_budget, 0);

  console.log("\n[7/8] reasoning_effort scales the model's own default ...");
  expect("low", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "low" }).thinkingConfig?.thinking_budget, 2500);
  expect("medium", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "medium" }).thinkingConfig?.thinking_budget, 10001);
  expect("high", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "high" }).thinkingConfig?.thinking_budget, 40004);
  expect("high stays dynamic on a dynamic model", openai(DYNAMIC, { max_tokens: 64000, reasoning_effort: "high" }).thinkingConfig?.thinking_budget, -1);
  expect("none", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "none" }).thinkingConfig?.thinking_budget, 0);

  console.log("\n[8/8] The answer reserve is configurable, and clamped at half ...");
  process.env.BRIDGE_ANSWER_RESERVE_TOKENS = "4096";
  expect("smaller reserve -> more room", anthropic(PRO_HIGH, { max_tokens: 12000 }).thinkingConfig?.thinking_budget, 7904);
  process.env.BRIDGE_ANSWER_RESERVE_TOKENS = "40000";
  expect("reserve clamped to half", anthropic(PRO_HIGH, { max_tokens: 12000 }).thinkingConfig?.thinking_budget, 6000);
  delete process.env.BRIDGE_ANSWER_RESERVE_TOKENS;

  console.log("\n[+] A non-thinking model gets no thinkingConfig at all ...");
  const plain = anthropic(PLAIN, { max_tokens: 100 });
  expect("maxOutputTokens", plain.maxOutputTokens, 100);
  expect("no thinkingConfig emitted", plain.thinkingConfig, undefined);

  if (failures > 0) {
    throw new Error(`${failures} thinking-budget check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL THINKING BUDGET CHECKS PASSED!");
  console.log("=================================================\n");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
