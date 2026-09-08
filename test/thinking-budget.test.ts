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

const THINKING_MODEL = "gemini-3-flash";
const PLAIN_MODEL = "gemini-2.5-flash";
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

function anthropic(body: Record<string, any>): any {
  return Transformer.anthropicToAntigravity({ model: THINKING_MODEL, messages: MESSAGES, ...body }).request
    .generationConfig;
}

function openai(body: Record<string, any>): any {
  return Transformer.openaiToAntigravity({ model: THINKING_MODEL, messages: MESSAGES, ...body }).request
    .generationConfig;
}

function runTests() {
  console.log("=================================================");
  console.log(" Thinking budget vs. caller output cap");
  console.log("=================================================\n");

  console.log("[1/7] Anthropic: a small explicit cap is honoured, not inflated ...");
  const tiny = anthropic({ max_tokens: 100 });
  expect("maxOutputTokens", tiny.maxOutputTokens, 100);
  expect("thinking disabled (no room for it)", tiny.thinkingConfig?.thinking_budget, 0);
  expect("include_thoughts", tiny.thinkingConfig?.include_thoughts, false);

  console.log("\n[2/7] Anthropic: a roomy cap keeps thinking, budget fits inside ...");
  const roomy = anthropic({ max_tokens: 8000 });
  expect("maxOutputTokens", roomy.maxOutputTokens, 8000);
  expect("thinking_budget", roomy.thinkingConfig?.thinking_budget, 4000);
  expect("budget leaves room for the answer", roomy.thinkingConfig.thinking_budget < roomy.maxOutputTokens, true);

  console.log("\n[3/7] Anthropic: no cap given -> default window, full budget ...");
  const uncapped = anthropic({});
  expect("maxOutputTokens", uncapped.maxOutputTokens, 64000);
  expect("thinking_budget", uncapped.thinkingConfig?.thinking_budget, 32768);

  console.log("\n[4/7] Anthropic: explicitly disabled thinking stays disabled ...");
  const off = anthropic({ max_tokens: 500, thinking: { type: "disabled" } });
  expect("maxOutputTokens", off.maxOutputTokens, 500);
  expect("thinking_budget", off.thinkingConfig?.thinking_budget, 0);

  console.log("\n[5/7] OpenAI: a small cap is honoured even at reasoning_effort high ...");
  const oaTiny = openai({ max_tokens: 100, reasoning_effort: "high" });
  expect("maxOutputTokens", oaTiny.maxOutputTokens, 100);
  expect("thinking_budget", oaTiny.thinkingConfig?.thinking_budget, 0);

  console.log("\n[6/7] OpenAI: requested effort is capped by the window ...");
  const oaMedium = openai({ max_tokens: 8000, reasoning_effort: "medium" });
  expect("maxOutputTokens", oaMedium.maxOutputTokens, 8000);
  expect("thinking_budget", oaMedium.thinkingConfig?.thinking_budget, 4000);

  console.log("\n[7/7] Non-thinking model: cap passed through untouched ...");
  const plain = Transformer.anthropicToAntigravity({ model: PLAIN_MODEL, messages: MESSAGES, max_tokens: 100 })
    .request.generationConfig;
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
