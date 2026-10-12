/**
 * Regression guard for the order of turns the bridge sends Google.
 *
 * Gemini requires a conversation to open with a user turn: a function call may only
 * come "immediately after a user turn or after a function response turn", and one that
 * opens the history is refused with exactly that message. Verified against Google, six
 * request shapes: only a history whose first turn is a model function call produced it.
 *
 * Clients can send such a history. OpenDesign's agent, after a long run of 100k-token
 * steps and one empty turn, re-sent a conversation that began with the assistant's tool
 * call (its earlier messages had been dropped), and the 400 ended the run. The bridge
 * now opens such a history with a short user note, so the call/response pairs that
 * remain stay intact and the request is valid.
 *
 * `describeContentsShape` is what the bridge logs when Google rejects a request: the
 * turns' roles and part kinds, never the text, so the next 400 can be read.
 *
 * Pure transformation — no server, no disk, no network, no quota.
 */
import { Transformer } from "../src/transformer";
import { describeContentsShape } from "../src/stream-diagnostics";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

const NOTE = "Earlier messages in this conversation were omitted";
const tools = [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }];

function anthropic(messages: any[], model = "gemini-3.8-flash-tiered"): any[] {
  return Transformer.anthropicToAntigravity({ model, messages, tools, max_tokens: 1000 }).request.contents || [];
}

function openai(messages: any[], model = "gemini-3.8-flash-tiered"): any[] {
  const oTools = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } } }];
  return Transformer.openaiToAntigravity({ model, messages, tools: oTools, max_tokens: 1000 }).request.contents || [];
}

const roles = (contents: any[]) => contents.map((c) => c.role).join(",");

const call = { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } };
const result = { type: "tool_result", tool_use_id: "call_1", content: "Secret code is 42." };

function runTests() {
  console.log("=================================================");
  console.log(" A history always opens with a user turn");
  console.log("=================================================\n");

  console.log("[1/5] A history that opens with the assistant's tool call is repaired ...");
  const leading = anthropic([
    { role: "assistant", content: [call] },
    { role: "user", content: [result] },
    { role: "user", content: "go on" },
  ]);
  expect("opens with a user turn", leading[0].role, "user");
  expect("the note says messages were omitted", String(leading[0].parts?.[0]?.text).includes(NOTE), true);
  expect("the call and its response survive, in order", roles(leading), "user,model,user");
  expect("the call is still there", Boolean(leading[1].parts.find((p: any) => p.functionCall)), true);
  expect("the response is still there", Boolean(leading[2].parts.find((p: any) => p.functionResponse)), true);

  console.log("\n[2/5] Other leading assistant turns, and a dropped first message ...");
  expect("leading assistant text", roles(anthropic([{ role: "assistant", content: "hello" }, { role: "user", content: "hi" }])), "user,model,user");
  expect(
    "an empty first user message is dropped, leaving the assistant first",
    roles(anthropic([{ role: "user", content: "   " }, { role: "assistant", content: [call] }, { role: "user", content: [result] }])),
    "user,model,user"
  );
  const withThinking = anthropic([
    { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "x" }, call] },
    { role: "user", content: [result] },
  ]);
  expect("thinking before a leading call: repaired, still one model turn", roles(withThinking), "user,model,user");
  const claude = anthropic([{ role: "assistant", content: [call] }, { role: "user", content: [result] }], "claude-sonnet-4-6");
  expect("a Claude target is repaired too", claude[0].role, "user");

  console.log("\n[3/5] A history that already opens with the user is left alone ...");
  const fine = anthropic([
    { role: "user", content: "Read a.txt" },
    { role: "assistant", content: [call] },
    { role: "user", content: [result] },
  ]);
  expect("same turns", roles(fine), "user,model,user");
  expect("first turn is the caller's own text", fine[0].parts[0].text, "Read a.txt");
  expect("no note added", JSON.stringify(fine).includes(NOTE), false);
  expect("an empty history stays empty", anthropic([]).length, 0);

  console.log("\n[4/5] The OpenAI path is repaired the same way ...");
  const oLeading = openai([
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "Secret code is 42." },
    { role: "user", content: "go on" },
  ]);
  expect("opens with a user turn", oLeading[0].role, "user");
  expect("the note is there", String(oLeading[0].parts?.[0]?.text).includes(NOTE), true);
  expect("the call and response survive", Boolean(oLeading.find((c: any) => c.parts.some((p: any) => p.functionCall))) && Boolean(oLeading.find((c: any) => c.parts.some((p: any) => p.functionResponse))), true);
  const oFine = openai([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
  expect("a normal OpenAI history is untouched", roles(oFine), "user");

  console.log("\n[5/5] The shape of a rejected request is readable and leaks no text ...");
  const shape = describeContentsShape([
    { role: "model", parts: [{ text: "secret thinking", thought: true }, { text: "secret thinking 2", thought: true }, { functionCall: { name: "read_file", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "read_file", response: { content: "Secret code is 42." } } }] },
    { role: "user", parts: [{ text: "private question" }] },
  ]);
  expect("names the roles and part kinds", shape, "3 turns: model:thought×2+call > user:response > user:text");
  expect("never carries the text of the conversation", /secret|private|42/i.test(shape), false);
  const longShape = describeContentsShape(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "model" : "user", parts: [{ text: "x" }] })));
  expect("a long history is abbreviated, with its true length", longShape.startsWith("40 turns:") && longShape.includes(" … ") && longShape.length < 400, true);
  expect("an empty history", describeContentsShape([]), "0 turns");
  expect("not an array", describeContentsShape(undefined as any), "0 turns");

  if (failures > 0) {
    throw new Error(`${failures} turn-order check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL TURN-ORDER CHECKS PASSED!");
  console.log("=================================================\n");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
