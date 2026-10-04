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
 * 3. The Anthropic stream reported `input_tokens: 0` forever. message_start has
 *    to be written before the first chunk arrives, when the prompt size is not
 *    yet known, and message_delta only ever carried output_tokens. Claude Code
 *    and T3 therefore saw zero context in use: no meter, and no auto-compact
 *    to fire before a long session overran the window.
 *
 * 4. The OpenAI stream sent no usage at all. The contract is one extra chunk —
 *    `choices: []` plus the totals — before [DONE], and only when the caller
 *    asks with `stream_options.include_usage`. The SDKs ask by default when
 *    they want a meter, and got silence.
 *
 * Streaming is the default for Claude Code, Hermes and Cursor, so these defects
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
/** usageMetadata the stub reports, and where it puts it. Null = upstream says nothing. */
let nextUsage: Record<string, number> | null = null;
let usageInLastChunk = false;
let usageWrapped = false;

(AntigravityClient.prototype as any).streamGenerateContent = async () =>
  (async function* () {
    const wrap = (chunk: any) => (usageWrapped ? { response: chunk } : chunk);
    const usage = nextUsage ? { usageMetadata: nextUsage } : {};
    yield wrap({ candidates: [{ content: { parts: nextParts } }], ...(usageInLastChunk ? {} : usage) });
    // Google reports usage on the final chunk as often as on the first.
    if (usageInLastChunk && nextUsage) yield wrap({ candidates: [{ content: { parts: [] } }], ...usage });
  })();

function resetUsage() {
  nextUsage = null;
  usageInLastChunk = false;
  usageWrapped = false;
}

/** Every OpenAI chunk that carries a `usage` object, in order. */
function openaiUsageChunks(sse: string): any[] {
  return eachEvent(sse).filter((ev) => ev.usage && typeof ev.usage === "object");
}

/** The usage object the Anthropic stream's message_delta carried. */
function anthropicDeltaUsage(sse: string): Record<string, unknown> {
  return eachEvent(sse).find((e) => e.type === "message_delta")?.usage ?? {};
}

async function collectSSE(path: string, model: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: "x" }],
      ...extra,
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
    console.log("[1/14] Anthropic SSE, turn ending in a tool call ...");
    nextParts = WITH_TOOL;
    expect("stop_reason", anthropicStopReason(await collectSSE("/v1/messages", "gemini-3-flash")), "tool_use");

    console.log("\n[2/14] Anthropic SSE, text-only turn ...");
    nextParts = TEXT_ONLY;
    expect("stop_reason", anthropicStopReason(await collectSSE("/v1/messages", "gemini-3-flash")), "end_turn");

    console.log("\n[3/14] OpenAI SSE, turn ending in a tool call ...");
    nextParts = WITH_TOOL;
    expect("finish_reason", openaiFinishReason(await collectSSE("/v1/chat/completions", "gemini-3-flash")), "tool_calls");

    console.log("\n[4/14] OpenAI SSE, text-only turn ...");
    nextParts = TEXT_ONLY;
    expect("finish_reason", openaiFinishReason(await collectSSE("/v1/chat/completions", "gemini-3-flash")), "stop");

    console.log("\n[5/14] OpenAI SSE, parallel tool calls keep distinct indices ...");
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

    console.log("\n[6/14] Anthropic SSE, parallel tool_use blocks keep distinct indices ...");
    nextParts = PARALLEL_TOOLS;
    const anthropicParallel = anthropicToolUseIndices(await collectSSE("/v1/messages", "gemini-3-flash"));
    expect("tool_use blocks emitted", anthropicParallel.length, 2);
    expect("block indices are distinct", new Set(anthropicParallel).size, 2);

    console.log("\n[7/14] Anthropic SSE reports the real prompt size ...");
    nextParts = TEXT_ONLY;
    nextUsage = { promptTokenCount: 4242, candidatesTokenCount: 7 };
    const reported = anthropicDeltaUsage(await collectSSE("/v1/messages", "gemini-3-flash"));
    expect("input_tokens in message_delta", reported.input_tokens, 4242);
    expect("output_tokens still reported", typeof reported.output_tokens, "number");

    console.log("\n[8/14] ... and does not invent a zero when upstream never said ...");
    resetUsage();
    const unknown = anthropicDeltaUsage(await collectSSE("/v1/messages", "gemini-3-flash"));
    expect("input_tokens omitted, not 0", "input_tokens" in unknown, false);
    expect("output_tokens still reported", typeof unknown.output_tokens, "number");

    console.log("\n[9/14] ... wherever upstream happens to put it ...");
    nextUsage = { promptTokenCount: 777 };
    usageInLastChunk = true;
    expect(
      "usage on the final chunk",
      anthropicDeltaUsage(await collectSSE("/v1/messages", "gemini-3-flash")).input_tokens,
      777
    );
    resetUsage();
    nextUsage = { promptTokenCount: 555 };
    usageWrapped = true;
    expect(
      "usage inside a response wrapper",
      anthropicDeltaUsage(await collectSSE("/v1/messages", "gemini-3-flash")).input_tokens,
      555
    );
    resetUsage();

    console.log("\n[10/14] OpenAI SSE sends a usage chunk when asked, after the finish chunk ...");
    nextParts = TEXT_ONLY;
    nextUsage = { promptTokenCount: 4242, candidatesTokenCount: 7 };
    const asked = await collectSSE("/v1/chat/completions", "gemini-3-flash", { stream_options: { include_usage: true } });
    const askedUsage = openaiUsageChunks(asked);
    expect("exactly one usage chunk", askedUsage.length, 1);
    expect("prompt_tokens", askedUsage[0]?.usage?.prompt_tokens, 4242);
    expect("completion_tokens", askedUsage[0]?.usage?.completion_tokens, 7);
    expect("total_tokens", askedUsage[0]?.usage?.total_tokens, 4249);
    expect("choices is an empty array", JSON.stringify(askedUsage[0]?.choices), "[]");
    expect("no reasoning reported -> reasoning_tokens 0", askedUsage[0]?.usage?.completion_tokens_details?.reasoning_tokens, 0);
    const askedEvents = eachEvent(asked);
    expect("it is the last event before [DONE]", askedEvents[askedEvents.length - 1]?.usage?.prompt_tokens, 4242);
    expect("the finish chunk still precedes it", askedEvents[askedEvents.length - 2]?.choices?.[0]?.finish_reason, "stop");
    expect("stream still ends with [DONE]", asked.trim().endsWith("data: [DONE]"), true);

    console.log("\n[11/14] ... and stays silent when not asked, even though upstream reported it ...");
    expect(
      "no stream_options -> no usage chunk",
      openaiUsageChunks(await collectSSE("/v1/chat/completions", "gemini-3-flash")).length,
      0
    );
    expect(
      "include_usage: false -> no usage chunk",
      openaiUsageChunks(
        await collectSSE("/v1/chat/completions", "gemini-3-flash", { stream_options: { include_usage: false } })
      ).length,
      0
    );

    console.log("\n[12/14] ... and never invents a zero when upstream never said ...");
    resetUsage();
    const silent = await collectSSE("/v1/chat/completions", "gemini-3-flash", { stream_options: { include_usage: true } });
    expect("no usage chunk rather than a zeroed one", openaiUsageChunks(silent).length, 0);
    expect("the turn still finishes", openaiFinishReason(silent), "stop");
    expect("and still terminates", silent.trim().endsWith("data: [DONE]"), true);

    resetUsage();
    nextParts = WITH_TOOL;
    nextUsage = { promptTokenCount: 99, candidatesTokenCount: 3 };
    const withTool = await collectSSE("/v1/chat/completions", "gemini-3-flash", { stream_options: { include_usage: true } });
    expect("usage does not disturb tool_calls finish_reason", openaiFinishReason(withTool), "tool_calls");
    expect("usage is still delivered", openaiUsageChunks(withTool)[0]?.usage?.prompt_tokens, 99);
    resetUsage();

    console.log("\n[13/14] ... and itemises reasoning inside completion_tokens, as OpenAI defines it ...");
    resetUsage();
    nextParts = TEXT_ONLY;
    nextUsage = { promptTokenCount: 4242, candidatesTokenCount: 7, thoughtsTokenCount: 300 };
    const thought = openaiUsageChunks(
      await collectSSE("/v1/chat/completions", "gemini-3-flash", { stream_options: { include_usage: true } })
    )[0]?.usage;
    expect("completion_tokens = visible 7 + reasoning 300", thought?.completion_tokens, 307);
    expect("reasoning_tokens", thought?.completion_tokens_details?.reasoning_tokens, 300);
    expect("total_tokens = prompt + completion", thought?.total_tokens, 4549);
    resetUsage();

    console.log("\n[14/14] The Anthropic stream's output_tokens counts thinking, from Google's own figure ...");
    // Until now this was an estimate from the text actually emitted — and what is
    // emitted for thinking is a short summary, not the thousands of tokens spent.
    nextParts = TEXT_ONLY;
    nextUsage = { promptTokenCount: 4242, candidatesTokenCount: 7, thoughtsTokenCount: 300 };
    const streamed = anthropicDeltaUsage(await collectSSE("/v1/messages", "gemini-3-flash"));
    expect("output_tokens = visible 7 + thinking 300", streamed.output_tokens, 307);
    expect("input_tokens still reported", streamed.input_tokens, 4242);

    nextUsage = { promptTokenCount: 4242, candidatesTokenCount: 7 };
    expect(
      "no thinking: output_tokens is Google's visible count",
      anthropicDeltaUsage(await collectSSE("/v1/messages", "gemini-3-flash")).output_tokens,
      7
    );
    resetUsage();

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
