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
import { SUPPORTED_MODELS } from "../src/constants";
import { zcodeReasoning } from "../src/zcode-sync";

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
// A stand-in rather than a real Google model: this suite checks the scaling, and a catalogue
// change (Google stopped serving gemini-3.1-pro-high) must not rewrite its numbers.
SUPPORTED_MODELS.push({
  id: "test-fixed-budget",
  name: "Test fixed budget",
  family: "gemini",
  contextLimit: 1048576,
  outputLimit: 65535,
  supportsThinking: true,
  thinkingBudget: 10001,
  minThinkingBudget: 128,
});
const FIXED = "test-fixed-budget"; // declared budget 10001
// A stand-in too: every model Google serves today can reason.
SUPPORTED_MODELS.push({
  id: "test-no-thinking",
  name: "Test no thinking",
  family: "gemini",
  contextLimit: 1048576,
  outputLimit: 65535,
  supportsThinking: false,
});
const NO_THINKING = "test-no-thinking";
const UNDECLARED = "gemini-3.5-flash-lite"; // can reason, declares no default budget

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

  console.log("[1/8] A dynamic model: effort picks the tier ...");
  expect("no effort -> dynamic, as before", anthropicBudget(DYNAMIC), -1);
  expect("low", anthropicBudget(DYNAMIC, effort("low")), 1000);
  expect("medium", anthropicBudget(DYNAMIC, effort("medium")), 4000);
  expect("high (Claude Code's default) stays dynamic", anthropicBudget(DYNAMIC, effort("high")), -1);
  expect("xhigh", anthropicBudget(DYNAMIC, effort("xhigh")), -1);
  expect("max", anthropicBudget(DYNAMIC, effort("max")), -1);

  console.log("\n[2/8] A fixed-budget model: the default level changes nothing ...");
  expect("no effort -> declared budget, as before", anthropicBudget(FIXED), 10001);
  expect("high == declared, so an upgrade changes no spend", anthropicBudget(FIXED, effort("high")), 10001);
  expect("low is a quarter", anthropicBudget(FIXED, effort("low")), 2500);
  expect("medium is a half", anthropicBudget(FIXED, effort("medium")), 5001);
  expect("xhigh doubles", anthropicBudget(FIXED, effort("xhigh")), 20002);
  expect("max is four times", anthropicBudget(FIXED, effort("max")), 40004);

  console.log("\n[3/8] Explicit instructions outrank effort ...");
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

  console.log("\n[4/8] Garbage is ignored rather than guessed at ...");
  expect("unknown level", anthropicBudget(FIXED, effort("ludicrous")), 10001);
  expect("non-string level", anthropicBudget(FIXED, effort(42)), 10001);
  expect("empty string", anthropicBudget(FIXED, effort("")), 10001);
  expect("effort in the wrong case still counts", anthropicBudget(DYNAMIC, effort("LOW")), 1000);
  expect("effort without any thinking block", anthropicBudget(DYNAMIC, { output_config: { effort: "low" } }), 1000);

  console.log("\n[5/8] A model that cannot think gets no thinking config ...");
  expect("effort on a non-thinking model", anthropicBudget(NO_THINKING, effort("max")), undefined);

  console.log("\n[5b/8] A model with no declared budget: only a level above the default turns it on ...");
  // Claude Code sends "high" on every request; it must not make every lite request reason.
  expect("no effort -> nothing sent", anthropicBudget(UNDECLARED), undefined);
  expect("high (Claude Code's default) -> nothing sent", anthropicBudget(UNDECLARED, effort("high")), undefined);
  expect("medium -> nothing sent", anthropicBudget(UNDECLARED, effort("medium")), undefined);
  expect("low -> nothing sent", anthropicBudget(UNDECLARED, effort("low")), undefined);
  expect("xhigh -> dynamic", anthropicBudget(UNDECLARED, effort("xhigh")), -1);
  expect("max -> dynamic", anthropicBudget(UNDECLARED, effort("max")), -1);
  expect("an explicit budget wins", anthropicBudget(UNDECLARED, { output_config: { effort: "high" }, thinking: { type: "enabled", budget_tokens: 2048 } }), 2048);

  console.log("\n[6/8] The OpenAI path is untouched by sharing the helper ...");
  expect("dynamic, low", openaiBudget(DYNAMIC, { reasoning_effort: "low" }), 1000);
  expect("dynamic, medium", openaiBudget(DYNAMIC, { reasoning_effort: "medium" }), 4000);
  expect("dynamic, high", openaiBudget(DYNAMIC, { reasoning_effort: "high" }), -1);
  expect("fixed, medium is still 1x", openaiBudget(FIXED, { reasoning_effort: "medium" }), 10001);
  expect("fixed, high is still 4x", openaiBudget(FIXED, { reasoning_effort: "high" }), 40004);
  expect("fixed, low is still a quarter", openaiBudget(FIXED, { reasoning_effort: "low" }), 2500);
  expect("none disables thinking", openaiBudget(FIXED, { reasoning_effort: "none" }), 0);

  console.log("\n[7/8] A retired fixed-tier id keeps the tier its name promised, on both paths ...");
  // gemini-3.6-flash-low declared 1000. Resolving it to the dynamic tiered model at its
  // own default would have made every step of a tool loop reason without bound.
  const realWarn = console.warn;
  console.warn = () => {};
  const tiers: Array<[string, unknown]> = [
    ["gemini-3.6-flash-low", 1000],
    ["gemini-3.5-flash-extra-low", 1000],
    ["gemini-3.1-pro-low", 1000],
    ["gemini-3.6-flash-medium", 4000],
    ["gemini-3.5-flash-low", 4000], // Google's own label for it was "Medium"
    ["gemini-3.6-flash-high", -1],
    ["gemini-3-flash-agent", -1],
  ];
  for (const [id, wanted] of tiers) {
    expect(`${id}: anthropic, no effort`, anthropicBudget(id), wanted);
    expect(`${id}: anthropic, Claude Code's "high" keeps it`, anthropicBudget(id, effort("high")), wanted);
    expect(`${id}: openai, no effort`, openaiBudget(id), wanted);
  }
  // The tier is the alias's default, so effort scales it exactly as it scaled the old
  // fixed model's declared 1000 — and an explicit budget still wins over all of it.
  expect("low alias, anthropic max", anthropicBudget("gemini-3.6-flash-low", effort("max")), 4000);
  expect("low alias, anthropic low", anthropicBudget("gemini-3.6-flash-low", effort("low")), 250);
  expect("low alias, openai high", openaiBudget("gemini-3.6-flash-low", { reasoning_effort: "high" }), 4000);
  expect("low alias, openai none", openaiBudget("gemini-3.6-flash-low", { reasoning_effort: "none" }), 0);
  expect("low alias, explicit budget wins", anthropicBudget("gemini-3.6-flash-low", { thinking: { type: "enabled", budget_tokens: 7777 } }), 7777);
  expect("low alias, reasoning_tokens wins", openaiBudget("gemini-3.6-flash-low", { reasoning_tokens: 3000 }), 3000);
  expect("the tier belongs to the alias, not the model it lands on", anthropicBudget("gemini-3.8-flash-tiered"), -1);
  // A name that says "thinking" asks for it, though the lite model it lands on does not
  // reason by default; the other two lite aliases keep the lite default.
  expect("gemini-2.5-flash-thinking reasons (anthropic)", anthropicBudget("gemini-2.5-flash-thinking", effort("high")), -1);
  expect("gemini-2.5-flash-thinking reasons (openai)", openaiBudget("gemini-2.5-flash-thinking"), -1);
  expect("gemini-2.5-flash-thinking, effort low", anthropicBudget("gemini-2.5-flash-thinking", effort("low")), 1000);
  expect("gemini-2.5-flash does not", anthropicBudget("gemini-2.5-flash", effort("high")), undefined);
  expect("the lite model itself does not", anthropicBudget(UNDECLARED, effort("high")), undefined);
  console.warn = realWarn;

  console.log("\n[7b/8] A reasoning suffix on an approximated id is kept as its tier, on both paths ...");
  // `gemini-3.8-flash-tiered-low` is the shape a client produces by appending a reasoning
  // level to a model name. The nearest-match guess used to drop it, so "-low" became
  // unbounded dynamic reasoning; now it reads the suffix the way a retired id carries a tier.
  const warned: string[] = [];
  console.warn = (...a: any[]) => {
    warned.push(a.map(String).join(" "));
  };
  const suffixed: Array<[string, unknown, string]> = [
    ["gemini-3.8-flash-tiered-low", 1000, "a suffix on an exact id"],
    ["gemini-3.8-flash-tiered-medium", 4000, "medium"],
    ["gemini-3.8-flash-tiered-high", -1, "high"],
    ["openrouter/gemini-3.8-flash-tiered-low", 1000, "behind a provider prefix"],
    ["open-design-byok/google/gemini-3.8-flash-tiered-medium", 4000, "behind a two-level prefix"],
    ["gemini-9-flash-extra-low", 1000, "-extra-low is Google's Low, not a stray segment"],
    ["some-pro-model-low", 1000, "a pro guess keeps its suffix too"],
    ["gemini-9-flash-lite-low", 1000, "on the lite model it lands on"],
  ];
  for (const [id, wanted, why] of suffixed) {
    expect(`${id} (${why}): anthropic`, anthropicBudget(id, effort("high")), wanted);
    expect(`${id} (${why}): openai`, openaiBudget(id), wanted);
  }
  // Only a whole trailing segment is a tier: "-lite" is a model, and these name none.
  expect("-lite is not a tier", anthropicBudget("gemini-9-flash-lite", effort("high")), undefined);
  expect("an unsuffixed guess keeps the model default", anthropicBudget("gemini-9-flash", effort("high")), -1);
  expect("'low' inside a name is not a suffix", anthropicBudget("gemini-lowkey-flash", effort("high")), -1);
  expect("a mid-name '-low-' is not a suffix", anthropicBudget("gemini-low-flash", effort("high")), -1);
  // Claude targets have a fixed budget; "-high" must not send them -1.
  expect("a claude guess ignores a suffix", anthropicBudget("claude-opus-9-high", effort("high")), 1024);
  // The suffix is the default, so effort scales it and an explicit budget still wins.
  expect("suffix -low, anthropic max", anthropicBudget("gemini-3.8-flash-tiered-low", effort("max")), 4000);
  expect("suffix -low, explicit budget wins", anthropicBudget("gemini-3.8-flash-tiered-low", { thinking: { type: "enabled", budget_tokens: 7777 } }), 7777);
  expect("suffix -low, openai none disables", openaiBudget("gemini-3.8-flash-tiered-low", { reasoning_effort: "none" }), 0);
  console.warn = realWarn;
  const lowWarning = warned.find((w) => w.includes('"gemini-3.8-flash-tiered-low"')) || "";
  expect("the approximated warning names the tier", lowWarning.includes("approximated") && lowWarning.includes("low reasoning tier"), true);
  const plainWarning = warned.find((w) => w.includes('"gemini-9-flash"')) || "";
  expect("and says nothing of a tier when there was none", plainWarning !== "" && !plainWarning.includes("reasoning tier"), true);

  console.log("\n[8/8] Every reasoning level ZCode is offered changes what is sent ...");
  // ZCode speaks the Anthropic protocol, so its variants arrive as output_config.effort.
  // A level that sends the same thing as another one is a control that does nothing.
  for (const model of SUPPORTED_MODELS.filter((m) => !m.id.startsWith("test-"))) {
    const reasoning = zcodeReasoning(model);
    if (!reasoning) continue;
    const sent = reasoning.variants.map((v) => anthropicBudget(model.id, effort(v)));
    expect(`${model.id}: ${reasoning.variants.join("/")} send distinct budgets (${sent.join("/")})`, new Set(sent).size, sent.length);
    expect(`${model.id}: the default variant is one of them`, reasoning.variants.includes(reasoning.defaultVariant), true);
  }
  expect("a model with no declared budget gets no picker", zcodeReasoning(SUPPORTED_MODELS.find((m) => m.id === UNDECLARED)!), undefined);
  expect("a model that cannot reason gets no picker", zcodeReasoning(SUPPORTED_MODELS.find((m) => m.id === NO_THINKING)!), undefined);

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
