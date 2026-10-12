/**
 * Live end-to-end suite: the only one that talks to Google for real.
 *
 * It needs a logged-in account (`npm run bridge:login`) and spends real quota, about
 * a dozen small requests. Everything else under test/ runs offline.
 *
 * Every model id below is used EXACTLY as the bridge exposes it. The suite used to send
 * retired or invented names (`gemini-3-flash`, `gemini-3.1-pro`, `gemini-3.7-flash`),
 * which the bridge quietly approximated or aliased onto models Google no longer serves,
 * so a green run said nothing about the models a client is actually offered. `[2/7]`
 * now refuses any id here that is not in the list, and a model that has gone away fails
 * with Google's own message instead of a stale alias hiding it.
 */
import { BridgeServer } from "../src/server";

const TEST_PORT = 52131;

/** Exact ids from SUPPORTED_MODELS. Change them only after `npm run bridge:models`. */
const FLASH = "gemini-3.8-flash-tiered";
const FLASH_DYNAMIC = "gemini-3.6-flash-high";
const PRO = "gemini-pro-agent"; // Google's High tier; the old gemini-3.1-pro-high answers 400 to everything
const CLAUDE = "claude-opus-4-6-thinking";

const HEADERS_ANTHROPIC = {
  "Content-Type": "application/json",
  "anthropic-version": "2023-06-01",
  "x-api-key": "test",
};

let skipped = 0;

function fail(what: string, body: unknown): never {
  throw new Error(`${what}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
}

function expectIncludes(what: string, haystack: string | undefined, needle: string) {
  if (!(haystack || "").toLowerCase().includes(needle.toLowerCase())) {
    fail(`${what}: expected the reply to contain "${needle}"`, haystack ?? "(no text)");
  }
}

async function post(path: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** A Claude request can fail for want of quota, which says nothing about the bridge. */
function isQuotaExhausted(status: number, body: string): boolean {
  return status === 429 || /rate limited|quota/i.test(body);
}

async function runTests() {
  console.log("=================================================");
  console.log(" Testing Antigravity ZCode Bridge Server (LIVE)");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT}`);

  try {
    // 1. Health
    console.log("\n[1/7] Testing GET /health ...");
    const healthRes = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const healthData = (await healthRes.json()) as any;
    if (healthRes.ok && healthData.status === "ok") {
      console.log(`✓ Health check passed:`, healthData);
    } else {
      fail("Health check failed", healthData);
    }

    // 2. Models, and that this suite only uses ids the bridge really exposes
    console.log("\n[2/7] Testing GET /v1/models, and the ids this suite uses ...");
    const modelsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/models`);
    const modelsData = (await modelsRes.json()) as any;
    if (!(modelsRes.ok && Array.isArray(modelsData.data) && modelsData.data.length > 0)) {
      fail("Models list failed", modelsData);
    }
    const listed = new Map<string, any>(modelsData.data.map((m: any) => [m.id, m]));
    console.log(`✓ Models list passed. Found ${listed.size} models.`);
    for (const id of [FLASH, FLASH_DYNAMIC, PRO, CLAUDE]) {
      const entry = listed.get(id);
      if (!entry) fail(`This suite uses "${id}", which the bridge does not list`, [...listed.keys()]);
      if (!(entry.context_length > 0)) fail(`"${id}" advertises no context_length`, entry);
    }
    console.log(`✓ Every id used below is exposed exactly, with a context_length.`);

    // 3. Anthropic, non-streaming
    console.log(`\n[3/7] Testing Anthropic POST /v1/messages (${FLASH}) ...`);
    const anthropicRes = await post("/v1/messages", HEADERS_ANTHROPIC, {
      model: FLASH,
      messages: [{ role: "user", content: "Reply with exactly: ANTHROPIC_TEST_OK" }],
      max_tokens: 200,
    });
    const anthropicData = (await anthropicRes.json()) as any;
    if (!(anthropicRes.ok && anthropicData.content)) fail("Anthropic non-streaming failed", anthropicData);
    const anthropicText = anthropicData.content.find((c: any) => c.type === "text")?.text;
    expectIncludes("Anthropic non-streaming", anthropicText, "ANTHROPIC_TEST_OK");
    if (!(anthropicData.usage?.input_tokens > 0)) fail("Anthropic non-streaming reported no prompt size", anthropicData.usage);
    console.log(`✓ Anthropic non-streaming response:`, anthropicText.trim());

    // 4. Anthropic SSE with thinking, on Claude (served through Vertex)
    console.log(`\n[4/7] Testing Anthropic SSE streaming POST /v1/messages (${CLAUDE}) ...`);
    const streamRes = await post("/v1/messages", HEADERS_ANTHROPIC, {
      model: CLAUDE,
      messages: [{ role: "user", content: "Count from 1 to 5 separated by spaces." }],
      stream: true,
      max_tokens: 200,
    });
    if (!streamRes.ok || !streamRes.body) {
      const errBody = await streamRes.text();
      if (isQuotaExhausted(streamRes.status, errBody)) {
        // Claude is metered apart from Gemini and is often the first thing to run dry.
        // Say so loudly rather than fail on something the bridge does not control.
        skipped++;
        console.warn(`⚠ SKIPPED: Claude quota is exhausted (HTTP ${streamRes.status}). The Claude path was NOT verified.`);
      } else {
        fail(`Anthropic streaming failed with HTTP ${streamRes.status}`, errBody);
      }
    } else {
      let streamedText = "";
      let streamedThinking = "";
      let stopReason = "";
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === "content_block_delta") {
              if (ev.delta?.type === "thinking_delta") streamedThinking += ev.delta.thinking;
              else if (ev.delta?.type === "text_delta") streamedText += ev.delta.text;
            } else if (ev.type === "message_delta") {
              stopReason = ev.delta?.stop_reason || stopReason;
            } else if (ev.type === "error") {
              fail("Anthropic stream carried an error event", ev);
            }
          } catch (e: any) {
            if (String(e.message).startsWith("Anthropic stream")) throw e;
          }
        }
      }

      if (!/1\D+2\D+3\D+4\D+5/.test(streamedText)) fail("Anthropic streaming: the count did not arrive", streamedText || "(no text)");
      if (!stopReason) fail("Anthropic streaming never closed the turn", streamedText);
      console.log(`✓ Anthropic SSE streaming finished (stop_reason=${stopReason}).`);
      if (streamedThinking) {
        console.log(`  Thinking captured (${streamedThinking.length} chars): ${streamedThinking.slice(0, 80)}...`);
      }
      console.log(`  Final Text Response: ${streamedText.trim()}`);
    }

    // 5. OpenAI chat completions, on a Pro model
    console.log(`\n[5/7] Testing OpenAI POST /v1/chat/completions (${PRO}) ...`);
    const openaiRes = await post(
      "/v1/chat/completions",
      { "Content-Type": "application/json", Authorization: "Bearer test" },
      { model: PRO, messages: [{ role: "user", content: "Say OPENAI_COMPAT_OK" }], max_tokens: 500 }
    );
    const openaiData = (await openaiRes.json()) as any;
    if (!(openaiRes.ok && openaiData.choices?.[0]?.message)) fail("OpenAI chat completions failed", openaiData);
    const msg = openaiData.choices[0].message;
    expectIncludes("OpenAI chat completions", msg.content, "OPENAI_COMPAT_OK");
    if (msg.reasoning_content) {
      console.log(`  Reasoning captured (${msg.reasoning_content.length} chars): ${msg.reasoning_content.slice(0, 60)}...`);
    }
    console.log(`✓ OpenAI chat completions response:`, msg.content.trim());

    // 6. Tools with a complex schema ($schema, propertyNames, additionalProperties)
    console.log(`\n[6/7] Testing Anthropic tool calling with a complex schema (${FLASH}) ...`);
    const toolRes = await post("/v1/messages", HEADERS_ANTHROPIC, {
      model: FLASH,
      messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for location",
          input_schema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            title: "WeatherParams",
            type: "object",
            additionalProperties: false,
            properties: {
              location: { type: "string", description: "City name", minLength: 1 },
              options: {
                type: "object",
                propertyNames: { pattern: "^[a-z_]+$" },
                properties: { unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
              },
            },
            required: ["location"],
          },
        },
      ],
      max_tokens: 500,
    });
    const toolData = (await toolRes.json()) as any;
    if (!(toolRes.ok && toolData.content)) fail("Tool calling failed", toolData);
    const toolUse = toolData.content.find((c: any) => c.type === "tool_use");
    if (!toolUse) fail("Tool calling: the model did not call the tool", toolData.content);
    if (toolUse.name !== "get_weather") fail("Tool calling: wrong tool", toolUse);
    expectIncludes("Tool calling arguments", String(toolUse.input?.location), "Tokyo");
    console.log(`✓ Tool calling test passed! Call:`, JSON.stringify(toolUse.input));

    // 7. Multi-turn tool history (Gemini 3 thought-signature validation)
    console.log(`\n[7/7] Testing multi-turn tool result history (${FLASH_DYNAMIC}) ...`);
    const multiTurnRes = await post("/v1/messages", HEADERS_ANTHROPIC, {
      model: FLASH_DYNAMIC,
      messages: [
        { role: "user", content: "Read file notes.txt and tell me the secret code." },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_read_1", name: "read_file", input: { path: "notes.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_read_1", content: "Secret code is 42." }],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read file contents",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      max_tokens: 300,
    });
    const multiTurnData = (await multiTurnRes.json()) as any;
    if (!(multiTurnRes.ok && multiTurnData.content)) fail("Multi-turn tool result failed", multiTurnData);
    const multiText = multiTurnData.content.find((c: any) => c.type === "text")?.text;
    expectIncludes("Multi-turn tool result", multiText, "42");
    console.log(`✓ Multi-turn tool result test passed! Assistant reply:`, multiText.trim());

    console.log("\n=================================================");
    if (skipped > 0) {
      console.log(` ✓ ${7 - skipped} of 7 VERIFICATION TESTS PASSED, ${skipped} SKIPPED (see ⚠ above)`);
    } else {
      console.log(" 🎉 ALL 7 VERIFICATION TESTS PASSED SUCCESSFULLY!");
    }
    console.log("=================================================\n");
  } finally {
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
