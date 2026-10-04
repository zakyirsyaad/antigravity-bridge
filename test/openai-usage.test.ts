/**
 * Regression guard for usage accounting on the OpenAI endpoint.
 *
 * handleOpenAIChatCompletions() never called UsageTracker.recordUsage on either
 * branch, so traffic from Hermes, Cursor and the OpenAI SDK was invisible:
 * `npm run bridge:usage` reported zero requests no matter how many had been
 * served. Only the Anthropic handler recorded anything.
 *
 * recordUsage is stubbed, so ~/.zcode/antigravity-usage.json is never written;
 * AntigravityClient is stubbed, so there is no network call and no quota spend.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { UsageTracker } from "../src/usage-tracker";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52141;
const MODEL = "gemini-3-flash";

type RecordedUsage = { model: string; input: number; output: number; thoughts: number };
let recorded: RecordedUsage[] = [];

(UsageTracker.prototype as any).recordUsage = (model: string, input: number, output: number, thoughts = 0) => {
  recorded.push({ model, input, output, thoughts });
};

(AntigravityClient.prototype as any).streamGenerateContent = async () =>
  (async function* () {
    yield { candidates: [{ content: { parts: [{ text: "hello from the stream" }] } }] };
  })();

/** Reasoning tokens the stubbed upstream reports for the next request. */
let upstreamThoughts = 0;

(AntigravityClient.prototype as any).generateContent = async () => ({
  candidates: [{ content: { parts: [{ text: "hello" }] } }],
  usageMetadata: {
    promptTokenCount: 11,
    candidatesTokenCount: 22,
    ...(upstreamThoughts ? { thoughtsTokenCount: upstreamThoughts } : {}),
  },
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

async function post(path: string, body: object): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.text();
}

async function postJson(path: string, body: object): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function runTests() {
  console.log("=================================================");
  console.log(" OpenAI endpoint usage accounting regression");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT} (upstream + tracker stubbed)\n`);

  try {
    console.log("[1/5] Non-streaming /v1/chat/completions records real token counts ...");
    recorded = [];
    await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "x" }] });
    expect("recordUsage calls", recorded.length, 1);
    expect("model", recorded[0]?.model, MODEL);
    expect("input tokens", recorded[0]?.input, 11);
    expect("output tokens", recorded[0]?.output, 22);

    console.log("\n[2/5] Streaming /v1/chat/completions records an estimate ...");
    recorded = [];
    await post("/v1/chat/completions", { model: MODEL, stream: true, messages: [{ role: "user", content: "x" }] });
    expect("recordUsage calls", recorded.length, 1);
    expect("model", recorded[0]?.model, MODEL);
    expect("output tokens estimated above zero", (recorded[0]?.output ?? 0) > 0, true);

    console.log("\n[3/5] Anthropic endpoint still records (no regression) ...");
    recorded = [];
    await post("/v1/messages", { model: MODEL, messages: [{ role: "user", content: "x" }] });
    expect("recordUsage calls", recorded.length, 1);

    console.log("\n[4/5] The response counts reasoning inside completion_tokens, and itemises it ...");
    // OpenAI defines completion_tokens as INCLUDING reasoning, with reasoning_tokens
    // as the subset. Reporting 300 reasoning beside 22 completion would be an
    // impossible pair that no client could subtract sensibly.
    upstreamThoughts = 300;
    recorded = [];
    const reasoned = await postJson("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "x" }] });
    expect("prompt_tokens", reasoned.usage?.prompt_tokens, 11);
    expect("completion_tokens = visible 22 + reasoning 300", reasoned.usage?.completion_tokens, 322);
    expect("reasoning_tokens itemised", reasoned.usage?.completion_tokens_details?.reasoning_tokens, 300);
    expect("total_tokens = prompt + completion", reasoned.usage?.total_tokens, 333);

    console.log("\n[5/5] ... without double counting it in the tracker, or inventing it when there is none ...");
    // recordUsage takes visible output and thoughts as separate columns. Feeding it
    // the new completion_tokens would count the reasoning twice in bridge:usage.
    expect("tracker output stays the visible 22", recorded[0]?.output, 22);
    expect("tracker thoughts column carries the 300", recorded[0]?.thoughts, 300);

    upstreamThoughts = 0;
    const plain = await postJson("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "x" }] });
    expect("no reasoning: completion_tokens unchanged", plain.usage?.completion_tokens, 22);
    expect("no reasoning: reasoning_tokens is 0", plain.usage?.completion_tokens_details?.reasoning_tokens, 0);
    expect("no reasoning: total unchanged", plain.usage?.total_tokens, 33);

    if (failures > 0) {
      throw new Error(`${failures} usage accounting check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL USAGE ACCOUNTING CHECKS PASSED!");
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
