/**
 * Regression guard for thought signatures across model families.
 *
 * Gemini 3 *requires* a thoughtSignature on thinking parts and on the first
 * functionCall of a model turn, so the bridge supplies the
 * SKIP_THOUGHT_SIGNATURE sentinel — Google accepts it.
 *
 * Claude models are not served by Gemini. Antigravity forwards them to Vertex's
 * Anthropic API, which validates the signature cryptographically instead of
 * accepting a sentinel, and the bridge cannot mint a real one. Sending the
 * sentinel there earned a hard 400:
 *
 *   messages.1.content.0: Invalid `signature` in `thinking` block
 *
 * So prior-turn thinking is dropped for Claude targets rather than sent with a
 * fabricated signature. Losing reasoning history costs context; sending it
 * costs the whole request.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import { Transformer } from "../src/transformer";
import { SKIP_THOUGHT_SIGNATURE } from "../src/constants";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

const multiTurn = (model: string) => ({
  model,
  max_tokens: 2048,
  messages: [
    { role: "user", content: "hitung 2+2" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "dua tambah dua ada empat" },
        { type: "text", text: "4" },
      ],
    },
    { role: "user", content: "lalu kali 3?" },
  ],
});

const partsOf = (payload: any): any[] =>
  (payload.request.contents || []).flatMap((c: any) => c.parts || []);
const thoughts = (payload: any) => partsOf(payload).filter((p: any) => p?.thought === true);

function runTests() {
  console.log("=================================================");
  console.log(" Thought signature handling per model family");
  console.log("=================================================\n");

  console.log("[1/4] Gemini keeps thinking history, sentinel intact ...");
  const gemini: any = Transformer.anthropicToAntigravity(multiTurn("gemini-3.8-flash-tiered"));
  const geminiThoughts = thoughts(gemini);
  expect("thinking part survives", geminiThoughts.length, 1);
  expect("carries the sentinel", geminiThoughts[0]?.thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  expect("snake_case variant too", geminiThoughts[0]?.thought_signature, SKIP_THOUGHT_SIGNATURE);

  console.log("\n[2/4] Claude drops thinking history instead of faking a signature ...");
  const claude: any = Transformer.anthropicToAntigravity(multiTurn("claude-sonnet-4-6"));
  expect("no thinking part sent", thoughts(claude).length, 0);
  const rawClaude = JSON.stringify(claude);
  expect("sentinel absent from payload", rawClaude.includes(SKIP_THOUGHT_SIGNATURE), false);
  expect("the visible answer survives", rawClaude.includes('"4"'), true);
  expect("the new question survives", rawClaude.includes("lalu kali 3?"), true);

  console.log("\n[3/4] A turn that was only thinking does not become an empty turn ...");
  const onlyThinking: any = Transformer.anthropicToAntigravity({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
      { role: "user", content: "b" },
    ],
  });
  const emptyTurns = (onlyThinking.request.contents || []).filter(
    (c: any) => !Array.isArray(c.parts) || c.parts.length === 0
  );
  expect("no part-less turn reaches Google", emptyTurns.length, 0);
  expect("no model turn left behind", (onlyThinking.request.contents || []).filter((c: any) => c.role === "model").length, 0);

  console.log("\n[4/4] Tool calls are untouched by this change ...");
  const withTool = (model: string) =>
    Transformer.anthropicToAntigravity({
      model,
      max_tokens: 1024,
      messages: [
        { role: "user", content: "pakai tool" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "perlu tool" },
            { type: "tool_use", id: "t1", name: "ls", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    }) as any;
  const firstCall = (p: any) => partsOf(p).find((x: any) => x?.functionCall);
  expect("gemini: first call keeps sentinel", firstCall(withTool("gemini-3.8-flash-tiered"))?.thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  expect("claude: the call itself still goes", !!firstCall(withTool("claude-sonnet-4-6")), true);
  expect("claude: but no thinking beside it", thoughts(withTool("claude-sonnet-4-6")).length, 0);

  if (failures > 0) {
    throw new Error(`${failures} thought signature check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL THOUGHT SIGNATURE CHECKS PASSED!");
  console.log("=================================================\n");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
