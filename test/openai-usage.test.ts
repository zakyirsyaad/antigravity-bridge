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

type RecordedUsage = { model: string; input: number; output: number };
let recorded: RecordedUsage[] = [];

(UsageTracker.prototype as any).recordUsage = (model: string, input: number, output: number) => {
  recorded.push({ model, input, output });
};

(AntigravityClient.prototype as any).streamGenerateContent = async () =>
  (async function* () {
    yield { candidates: [{ content: { parts: [{ text: "hello from the stream" }] } }] };
  })();

(AntigravityClient.prototype as any).generateContent = async () => ({
  candidates: [{ content: { parts: [{ text: "hello" }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
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

async function runTests() {
  console.log("=================================================");
  console.log(" OpenAI endpoint usage accounting regression");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT} (upstream + tracker stubbed)\n`);

  try {
    console.log("[1/3] Non-streaming /v1/chat/completions records real token counts ...");
    recorded = [];
    await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "x" }] });
    expect("recordUsage calls", recorded.length, 1);
    expect("model", recorded[0]?.model, MODEL);
    expect("input tokens", recorded[0]?.input, 11);
    expect("output tokens", recorded[0]?.output, 22);

    console.log("\n[2/3] Streaming /v1/chat/completions records an estimate ...");
    recorded = [];
    await post("/v1/chat/completions", { model: MODEL, stream: true, messages: [{ role: "user", content: "x" }] });
    expect("recordUsage calls", recorded.length, 1);
    expect("model", recorded[0]?.model, MODEL);
    expect("output tokens estimated above zero", (recorded[0]?.output ?? 0) > 0, true);

    console.log("\n[3/3] Anthropic endpoint still records (no regression) ...");
    recorded = [];
    await post("/v1/messages", { model: MODEL, messages: [{ role: "user", content: "x" }] });
    expect("recordUsage calls", recorded.length, 1);

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
