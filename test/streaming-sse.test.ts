/**
 * Regression guard for hand-written SSE framing in src/server.ts.
 *
 * Both streaming handlers are written by hand and share no code with the
 * non-streaming Transformer, so they have drifted from it twice:
 *
 * 1. Turn terminators were hardcoded — Anthropic always sent
 *    `stop_reason: "end_turn"`, OpenAI always `finish_reason: "stop"` — even
 *    after emitting a tool call. Agent loops branch on those values, so a
 *    streamed tool call was never dispatched.
 * 2. Every OpenAI tool_call delta carried `index: 0`. Clients accumulate those
 *    deltas keyed by index, so parallel calls collapsed into one entry with
 *    concatenated names and unparseable arguments.
 *
 * Streaming is the default for Claude Code, Hermes and Cursor, so both defects
 * hit every primary client while bridge.test.ts stayed green — it exercises
 * tool calling only without `stream: true`.
 *
 * Unlike bridge.test.ts, this suite stubs AntigravityClient, so it needs no
 * logged-in account and consumes no quota. Safe to run in CI.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52139;

type Part = Record<string, any>;

const TEXT_ONLY: Part[] = [{ text: "hello" }];
const WITH_TOOL: Part[] = [
  { text: "let me check" },
  { functionCall: { name: "get_weather", args: { location: "Tokyo" } } },
];
/** Two calls in one turn — the shape that collapsed under a shared index. */
const PARALLEL_TOOLS: Part[] = [
  { functionCall: { name: "get_weather", args: { location: "Tokyo" } } },
  { functionCall: { name: "get_weather", args: { location: "Paris" } } },
];

/** Parts the stubbed upstream yields for the next request. */
let nextParts: Part[] = [];

(AntigravityClient.prototype as any).streamGenerateContent = async () =>
  (async function* () {
    yield { candidates: [{ content: { parts: nextParts } }] };
  })();

async function collectSSE(path: string, model: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  return await res.text();
}

function eachEvent(sse: string): any[] {
  const events: any[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      // Ignore non-JSON frames
    }
  }
  return events;
}

/** stop_reason carried by the Anthropic message_delta event. */
function anthropicStopReason(sse: string): string {
  const ev = eachEvent(sse).find((e) => e.type === "message_delta");
  return String(ev?.delta?.stop_reason ?? "<none>");
}

/** Every tool_call delta the OpenAI stream emitted, in order. */
function openaiToolCallDeltas(sse: string): any[] {
  const deltas: any[] = [];
  for (const ev of eachEvent(sse)) {
    const calls = ev.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(calls)) deltas.push(...calls);
  }
  return deltas;
}

/**
 * Reassemble tool calls the way the OpenAI SDK does: accumulate each delta into
 * the slot named by its `index`, concatenating name and argument fragments.
 * With a shared index this collapses parallel calls into one broken entry.
 */
function accumulateByIndex(deltas: any[]): Map<number, { name: string; args: string }> {
  const calls = new Map<number, { name: string; args: string }>();
  for (const delta of deltas) {
    const slot = calls.get(delta.index) ?? { name: "", args: "" };
    slot.name += delta.function?.name ?? "";
    slot.args += delta.function?.arguments ?? "";
    calls.set(delta.index, slot);
  }
  return calls;
}

/**
 * Read `location` out of accumulated arguments. Reports the corruption rather
 * than throwing, so a shared index does not abort the remaining checks —
 * concatenated fragments like `{"location":"Tokyo"}{"location":"Paris"}` are
 * not valid JSON.
 */
function parsedLocation(args: string | undefined): string {
  try {
    return JSON.parse(args || "{}").location ?? "<missing>";
  } catch {
    return `<unparseable: ${args}>`;
  }
}

/** content_block indices of the Anthropic stream's tool_use blocks. */
function anthropicToolUseIndices(sse: string): number[] {
  return eachEvent(sse)
    .filter((ev) => ev.type === "content_block_start" && ev.content_block?.type === "tool_use")
    .map((ev) => ev.index);
}

/** finish_reason on the last OpenAI chunk that carries one. */
function openaiFinishReason(sse: string): string {
  let last = "<none>";
  for (const ev of eachEvent(sse)) {
    const reason = ev.choices?.[0]?.finish_reason;
    if (reason) last = String(reason);
  }
  return last;
}

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" Streaming SSE framing regression");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT} (upstream stubbed)\n`);

  try {
    console.log("[1/6] Anthropic SSE, turn ending in a tool call ...");
    nextParts = WITH_TOOL;
    expect("stop_reason", anthropicStopReason(await collectSSE("/v1/messages", "gemini-3-flash")), "tool_use");

    console.log("\n[2/6] Anthropic SSE, text-only turn ...");
    nextParts = TEXT_ONLY;
    expect("stop_reason", anthropicStopReason(await collectSSE("/v1/messages", "gemini-3-flash")), "end_turn");

    console.log("\n[3/6] OpenAI SSE, turn ending in a tool call ...");
    nextParts = WITH_TOOL;
    expect("finish_reason", openaiFinishReason(await collectSSE("/v1/chat/completions", "gemini-3-flash")), "tool_calls");

    console.log("\n[4/6] OpenAI SSE, text-only turn ...");
    nextParts = TEXT_ONLY;
    expect("finish_reason", openaiFinishReason(await collectSSE("/v1/chat/completions", "gemini-3-flash")), "stop");

    console.log("\n[5/6] OpenAI SSE, parallel tool calls keep distinct indices ...");
    nextParts = PARALLEL_TOOLS;
    const parallelSSE = await collectSSE("/v1/chat/completions", "gemini-3-flash");
    const deltas = openaiToolCallDeltas(parallelSSE);
    expect("tool_call deltas emitted", deltas.length, 2);
    expect("first delta index", deltas[0]?.index, 0);
    expect("second delta index", deltas[1]?.index, 1);

    // What the client actually ends up with after accumulating by index.
    const rebuilt = accumulateByIndex(deltas);
    expect("distinct tool calls reconstructed", rebuilt.size, 2);
    expect("call 0 name", rebuilt.get(0)?.name, "get_weather");
    expect("call 1 name", rebuilt.get(1)?.name, "get_weather");
    expect("call 0 location", parsedLocation(rebuilt.get(0)?.args), "Tokyo");
    expect("call 1 location", parsedLocation(rebuilt.get(1)?.args), "Paris");

    console.log("\n[6/6] Anthropic SSE, parallel tool_use blocks keep distinct indices ...");
    nextParts = PARALLEL_TOOLS;
    const anthropicParallel = anthropicToolUseIndices(await collectSSE("/v1/messages", "gemini-3-flash"));
    expect("tool_use blocks emitted", anthropicParallel.length, 2);
    expect("block indices are distinct", new Set(anthropicParallel).size, 2);

    if (failures > 0) {
      throw new Error(`${failures} streaming SSE check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL STREAMING SSE CHECKS PASSED!");
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
