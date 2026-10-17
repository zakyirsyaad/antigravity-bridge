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
import { SUPPORTED_MODELS } from "../src/constants";

/**
 * A fixed, generous budget (10001, floor 128). It is a stand-in registered here rather than a real
 * Google model: this suite checks the arithmetic, and it used to depend on `gemini-3.1-pro-high`,
 * which Google later stopped serving, so a catalogue change would have rewritten the numbers.
 */
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
const PRO_HIGH = "test-fixed-budget";
/** Declared budget -1: the model sizes its own reasoning. Floor 32. */
const DYNAMIC = "gemini-3.8-flash-tiered";
/** Tier chosen per request rather than baked into the id. */
const TIERED = "gemini-3.8-flash-tiered";
/**
 * No thinking support at all. A stand-in: every model Google serves today can reason, and this
 * suite used to borrow gemini-3.1-flash-lite until Google started declaring that it can.
 */
SUPPORTED_MODELS.push({
  id: "test-no-thinking",
  name: "Test no thinking",
  family: "gemini",
  contextLimit: 1048576,
  outputLimit: 65535,
  supportsThinking: false,
});
const PLAIN = "test-no-thinking";
/** Can reason, but declares no default budget: does not reason unless asked. */
const LITE = "gemini-3.5-flash-lite";
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
  expect("claude opus", anthropic("claude-opus-4-6-thinking", { max_tokens: 64000 }).thinkingConfig?.thinking_budget, 1024);
  expect("gpt-oss", anthropic("gpt-oss-120b-medium", { max_tokens: 64000 }).thinkingConfig?.thinking_budget, 8192);
  expect("fixed stand-in", anthropic(PRO_HIGH, { max_tokens: 64000 }).thinkingConfig?.thinking_budget, 10001);

  console.log("\n[5/8] A dynamic model keeps sizing its own reasoning ...");
  const dyn = anthropic(DYNAMIC, { max_tokens: 64000 });
  expect("thinking_budget", dyn.thinkingConfig?.thinking_budget, -1);
  expect("include_thoughts", dyn.thinkingConfig?.include_thoughts, true);
  const dynNoCap = anthropic(DYNAMIC);
  expect("still gets a default window", dynNoCap.maxOutputTokens, 64000);
  expect("still dynamic", dynNoCap.thinkingConfig?.thinking_budget, -1);
  // This model's floor is 32, so a 100-token window still has room (50). Only
  // below twice the floor does thinking actually get switched off. At 100 the room
  // is pinned rather than left dynamic: see [5b/8].
  expect("pinned to the room at 100", anthropic(DYNAMIC, { max_tokens: 100 }).thinkingConfig?.thinking_budget, 50);
  expect("no room -> disabled", anthropic(DYNAMIC, { max_tokens: 50 }).thinkingConfig?.thinking_budget, 0);

  console.log("\n[5b/8] A dynamic model cannot spend a small cap entirely on thinking ...");
  // Forwarding -1 lets the model reason until the window is gone: measured on
  // gemini-3.8-flash-tiered, max_tokens 1200 spent 1150 on thought and left 46 for
  // the answer, and OpenDesign got a MAX_TOKENS turn with no text ("empty output").
  // Below DYNAMIC_PIN_BELOW of room the budget is pinned to the room instead, so
  // the reserve held back for the answer is real.
  for (const [cap, room] of [[1200, 600], [2500, 1250], [4096, 2048], [6000, 3000]] as const) {
    const cfg = anthropic(TIERED, { max_tokens: cap });
    expect(`cap ${cap}: budget pinned to the room`, cfg.thinkingConfig?.thinking_budget, room);
    expect(`cap ${cap}: still thinking`, cfg.thinkingConfig?.include_thoughts, true);
    expect(`cap ${cap}: the caller's cap is untouched`, cfg.maxOutputTokens, cap);
    expect(`cap ${cap}: answer reserve is real`, cap - (cfg.thinkingConfig?.thinking_budget as number) >= room, true);
  }
  expect("openai path pins too", openai(TIERED, { max_tokens: 1200 }).thinkingConfig?.thinking_budget, 600);
  expect("a roomier cap stays dynamic (8192 -> 4096 room)", anthropic(TIERED, { max_tokens: 8192 }).thinkingConfig?.thinking_budget, -1);
  expect("Claude Code's usual cap stays dynamic", anthropic(TIERED, { max_tokens: 32000 }).thinkingConfig?.thinking_budget, -1);
  expect("no cap at all stays dynamic", anthropic(TIERED).thinkingConfig?.thinking_budget, -1);
  expect("an explicit budget still wins over the pin", anthropic(TIERED, { max_tokens: 4096, thinking: { budget_tokens: 500 } }).thinkingConfig?.thinking_budget, 500);
  expect("thinking disabled is still disabled", anthropic(TIERED, { max_tokens: 4096, thinking: { type: "disabled" } }).thinkingConfig?.thinking_budget, 0);
  process.env.BRIDGE_ANSWER_RESERVE_TOKENS = "500";
  expect("a smaller reserve leaves more to think with", anthropic(TIERED, { max_tokens: 2500 }).thinkingConfig?.thinking_budget, 2000);
  delete process.env.BRIDGE_ANSWER_RESERVE_TOKENS;

  console.log("\n[6/8] Explicit caller budgets and disabling still win ...");
  expect("explicit budget", anthropic(PRO_HIGH, { max_tokens: 64000, thinking: { budget_tokens: 2048 } }).thinkingConfig?.thinking_budget, 2048);
  expect("disabled", anthropic(PRO_HIGH, { max_tokens: 500, thinking: { type: "disabled" } }).thinkingConfig?.thinking_budget, 0);

  console.log("\n[7/8] reasoning_effort scales the model's own default ...");
  expect("low", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "low" }).thinkingConfig?.thinking_budget, 2500);
  expect("medium", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "medium" }).thinkingConfig?.thinking_budget, 10001);
  expect("high", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "high" }).thinkingConfig?.thinking_budget, 40004);
  expect("high stays dynamic on a dynamic model", openai(DYNAMIC, { max_tokens: 64000, reasoning_effort: "high" }).thinkingConfig?.thinking_budget, -1);
  expect("none", openai(PRO_HIGH, { max_tokens: 64000, reasoning_effort: "none" }).thinkingConfig?.thinking_budget, 0);

  console.log("\n[7b/8] A tiered model picks its tier from reasoning_effort ...");
  // The whole point of a tiered id: Antigravity's own picker maps "flash" to
  // gemini-3.8-flash-tiered and slides reasoning low..high per request, so
  // effort has to produce a real budget here rather than staying dynamic.
  expect("low", openai(TIERED, { max_tokens: 64000, reasoning_effort: "low" }).thinkingConfig?.thinking_budget, 1000);
  expect("medium", openai(TIERED, { max_tokens: 64000, reasoning_effort: "medium" }).thinkingConfig?.thinking_budget, 4000);
  expect("high stays dynamic", openai(TIERED, { max_tokens: 64000, reasoning_effort: "high" }).thinkingConfig?.thinking_budget, -1);
  expect("default is dynamic", anthropic(TIERED, { max_tokens: 64000 }).thinkingConfig?.thinking_budget, -1);
  expect("explicit budget wins", anthropic(TIERED, { max_tokens: 64000, thinking: { budget_tokens: 12000 } }).thinkingConfig?.thinking_budget, 12000);

  console.log("\n[8/8] The answer reserve is configurable, and clamped at half ...");
  process.env.BRIDGE_ANSWER_RESERVE_TOKENS = "4096";
  expect("smaller reserve -> more room", anthropic(PRO_HIGH, { max_tokens: 12000 }).thinkingConfig?.thinking_budget, 7904);
  process.env.BRIDGE_ANSWER_RESERVE_TOKENS = "40000";
  expect("reserve clamped to half", anthropic(PRO_HIGH, { max_tokens: 12000 }).thinkingConfig?.thinking_budget, 6000);
  delete process.env.BRIDGE_ANSWER_RESERVE_TOKENS;

  console.log("\n[8b/8] An agent request can be given a larger output floor, opt-in ...");
  // OpenDesign's agent asked for one `write` call carrying a ~40,000-token file with a
  // 16,384 cap. Google drops a function call the cap cuts off, so the bridge saw
  // text=0 tools=0 and the client reported "empty output". The client's own setting
  // did not reach that path, so the bridge can raise the floor — only when asked to,
  // and only for requests that carry tools.
  const aTools = [{ name: "write", description: "write a file", input_schema: { type: "object", properties: {} } }];
  const oTools = [{ type: "function", function: { name: "write", description: "write a file", parameters: { type: "object", properties: {} } } }];
  delete process.env.BRIDGE_TOOL_MIN_OUTPUT_TOKENS;
  expect("off by default: the caller's cap stands", anthropic(TIERED, { max_tokens: 16384, tools: aTools }).maxOutputTokens, 16384);
  process.env.BRIDGE_TOOL_MIN_OUTPUT_TOKENS = "65536";
  expect("anthropic + tools: raised to the floor", anthropic(TIERED, { max_tokens: 16384, tools: aTools }).maxOutputTokens, 65536);
  expect("openai + tools: raised to the floor", openai(TIERED, { max_tokens: 16384, tools: oTools }).maxOutputTokens, 65536);
  expect("no tools: the caller's cap stands", anthropic(TIERED, { max_tokens: 16384 }).maxOutputTokens, 16384);
  expect("empty tools list: the caller's cap stands", anthropic(TIERED, { max_tokens: 16384, tools: [] }).maxOutputTokens, 16384);
  expect("a larger cap is never lowered", anthropic(TIERED, { max_tokens: 100000, tools: aTools }).maxOutputTokens, 100000);
  expect("no cap sent: the usual default, not the floor", anthropic(TIERED, { tools: aTools }).maxOutputTokens, 64000);
  process.env.BRIDGE_TOOL_MIN_OUTPUT_TOKENS = "200000";
  expect("never above what the model can write", anthropic(TIERED, { max_tokens: 16384, tools: aTools }).maxOutputTokens, 65536);
  expect("a lower model limit wins (claude, 64000)", anthropic("claude-opus-4-6-thinking", { max_tokens: 16384, tools: aTools }).maxOutputTokens, 64000);
  for (const junk of ["abc", "-5", "0", ""]) {
    process.env.BRIDGE_TOOL_MIN_OUTPUT_TOKENS = junk;
    expect(`ignored when set to "${junk}"`, anthropic(TIERED, { max_tokens: 16384, tools: aTools }).maxOutputTokens, 16384);
  }
  // The thinking budget is fitted to the cap that is actually sent: 12000 squeezes a
  // fixed 10001 budget to 6000, and the raised window gives it back.
  process.env.BRIDGE_TOOL_MIN_OUTPUT_TOKENS = "65536";
  expect("budget is fitted to the raised window", anthropic(PRO_HIGH, { max_tokens: 12000, tools: aTools }).thinkingConfig?.thinking_budget, 10001);
  expect("without the floor it was squeezed", anthropic(PRO_HIGH, { max_tokens: 12000 }).thinkingConfig?.thinking_budget, 6000);
  delete process.env.BRIDGE_TOOL_MIN_OUTPUT_TOKENS;

  console.log("\n[+] A non-thinking model gets no thinkingConfig at all ...");
  const plain = anthropic(PLAIN, { max_tokens: 100 });
  expect("maxOutputTokens", plain.maxOutputTokens, 100);
  expect("no thinkingConfig emitted", plain.thinkingConfig, undefined);
  expect("not even when asked", anthropic(PLAIN, { max_tokens: 64000, thinking: { budget_tokens: 4000 } }).thinkingConfig, undefined);

  console.log("\n[++] A model with no declared budget is left to Google's default unless asked ...");
  // The Flash Lites can reason, but with no thinkingConfig they do not (0 thought tokens,
  // against ~200 when sent -1). Defaulting them to -1 would make every lite request reason.
  expect("anthropic: nothing sent by default", anthropic(LITE, { max_tokens: 64000 }).thinkingConfig, undefined);
  expect("openai: nothing sent by default", openai(LITE, { max_tokens: 64000 }).thinkingConfig, undefined);
  expect("no cap, no budget: the cap is not inflated either", anthropic(LITE).maxOutputTokens, undefined);
  expect("openai medium (its default level) changes nothing", openai(LITE, { max_tokens: 64000, reasoning_effort: "medium" }).thinkingConfig, undefined);
  expect("openai low changes nothing", openai(LITE, { max_tokens: 64000, reasoning_effort: "low" }).thinkingConfig, undefined);
  expect("openai high asks for dynamic reasoning", openai(LITE, { max_tokens: 64000, reasoning_effort: "high" }).thinkingConfig?.thinking_budget, -1);
  expect("an explicit budget is honoured", anthropic(LITE, { max_tokens: 64000, thinking: { budget_tokens: 2048 } }).thinkingConfig?.thinking_budget, 2048);
  expect("reasoning_tokens is honoured", openai(LITE, { max_tokens: 64000, reasoning_tokens: 3000 }).thinkingConfig?.thinking_budget, 3000);
  expect("an explicit budget still fits the cap", anthropic(LITE, { max_tokens: 2000, thinking: { budget_tokens: 4000 } }).thinkingConfig?.thinking_budget, 1000);
  expect("below the 128 floor -> disabled", anthropic(LITE, { max_tokens: 200, thinking: { budget_tokens: 4000 } }).thinkingConfig?.thinking_budget, 0);
  expect("disabled is sent as disabled", anthropic(LITE, { max_tokens: 64000, thinking: { type: "disabled" } }).thinkingConfig?.thinking_budget, 0);

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
