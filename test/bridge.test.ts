import { BridgeServer } from "../src/server";
import { BRIDGE_DEFAULT_PORT, SUPPORTED_MODELS } from "../src/constants";

async function runTests() {
  console.log("=================================================");
  console.log(" Testing Antigravity ZCode Bridge Server");
  console.log("=================================================\n");

  const TEST_PORT = 52131;
  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT}`);

  try {
    // 1. Test Health Endpoint
    console.log("\n[1/6] Testing GET /health ...");
    const healthRes = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const healthData = (await healthRes.json()) as any;
    if (healthRes.ok && healthData.status === "ok") {
      console.log(`✓ Health check passed:`, healthData);
    } else {
      throw new Error(`Health check failed: ${JSON.stringify(healthData)}`);
    }

    // 2. Test Models Endpoint
    console.log("\n[2/5] Testing GET /v1/models ...");
    const modelsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/models`);
    const modelsData = (await modelsRes.json()) as any;
    if (modelsRes.ok && Array.isArray(modelsData.data) && modelsData.data.length > 0) {
      console.log(`✓ Models list passed. Found ${modelsData.data.length} models:`);
      modelsData.data.forEach((m: any) => console.log(`  - ${m.id}`));
    } else {
      throw new Error(`Models list failed: ${JSON.stringify(modelsData)}`);
    }

    // 3. Test Anthropic Non-Streaming Messages
    console.log("\n[3/5] Testing Anthropic POST /v1/messages (gemini-3-flash) ...");
    const anthropicRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test",
      },
      body: JSON.stringify({
        model: "gemini-3-flash",
        messages: [{ role: "user", content: "Reply with exactly: ANTHROPIC_TEST_OK" }],
        max_tokens: 100,
      }),
    });

    const anthropicData = (await anthropicRes.json()) as any;
    if (anthropicRes.ok && anthropicData.content) {
      const textBlock = anthropicData.content.find((c: any) => c.type === "text");
      console.log(`✓ Anthropic non-streaming response:`, textBlock?.text?.trim());
    } else {
      throw new Error(`Anthropic non-streaming failed: ${JSON.stringify(anthropicData)}`);
    }

    // 4. Test Anthropic SSE Streaming with Claude Opus Thinking
    console.log("\n[4/5] Testing Anthropic SSE Streaming POST /v1/messages (claude-opus-4-6-thinking) ...");
    const streamRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        messages: [{ role: "user", content: "Count from 1 to 5 separated by spaces." }],
        stream: true,
        max_tokens: 200,
      }),
    });

    if (!streamRes.ok || !streamRes.body) {
      throw new Error(`Anthropic streaming failed with HTTP ${streamRes.status}`);
    }

    let streamedText = "";
    let streamedThinking = "";
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
        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          try {
            const ev = JSON.parse(jsonStr);
            if (ev.type === "content_block_delta") {
              if (ev.delta?.type === "thinking_delta") {
                streamedThinking += ev.delta.thinking;
              } else if (ev.delta?.type === "text_delta") {
                streamedText += ev.delta.text;
              }
            }
          } catch {}
        }
      }
    }

    console.log(`✓ Anthropic SSE streaming finished!`);
    if (streamedThinking) {
      console.log(`  Thinking tokens captured (${streamedThinking.length} chars): ${streamedThinking.slice(0, 80)}...`);
    }
    console.log(`  Final Text Response: ${streamedText.trim()}`);

    // 5. Test OpenAI Chat Completions Endpoint
    console.log("\n[5/5] Testing OpenAI POST /v1/chat/completions (gemini-3.1-pro) ...");
    const openaiRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "Say OPENAI_COMPAT_OK" }],
        max_tokens: 500,
      }),
    });

    const openaiData = (await openaiRes.json()) as any;
    if (openaiRes.ok && openaiData.choices?.[0]?.message) {
      const msg = openaiData.choices[0].message;
      if (msg.reasoning_content) {
        console.log(`  Reasoning captured (${msg.reasoning_content.length} chars): ${msg.reasoning_content.slice(0, 60)}...`);
      }
      console.log(`✓ OpenAI chat completions response:`, msg.content?.trim());
    } else {
      throw new Error(`OpenAI chat completions failed: ${JSON.stringify(openaiData)}`);
    }

    // 6. Test Anthropic Tools with Complex Schema ($schema, propertyNames, additionalProperties)
    console.log("\n[6/6] Testing Anthropic Tool Calling with Complex Schema (gemini-3.7-flash) ...");
    const toolRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test",
      },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
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
                location: {
                  type: "string",
                  description: "City name",
                  minLength: 1,
                },
                options: {
                  type: "object",
                  propertyNames: { pattern: "^[a-z_]+$" },
                  properties: {
                    unit: { type: "string", enum: ["celsius", "fahrenheit"] },
                  },
                },
              },
              required: ["location"],
            },
          },
        ],
        max_tokens: 500,
      }),
    });

    const toolData = (await toolRes.json()) as any;
    if (toolRes.ok && toolData.content) {
      console.log(`✓ Tool calling test passed! Content:`, toolData.content);
    } else {
      throw new Error(`Tool calling failed: ${JSON.stringify(toolData)}`);
    }

    // 7. Test Multi-turn Tool History with Anthropic Format (Gemini 3 Thought Signature Validation)
    console.log("\n[7/7] Testing Multi-turn Tool Result History (gemini-3.7-flash-high) ...");
    const multiTurnRes = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test",
      },
      body: JSON.stringify({
        model: "gemini-3.7-flash-high",
        messages: [
          { role: "user", content: "Read file notes.txt" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_read_1",
                name: "read_file",
                input: { path: "notes.txt" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_read_1",
                content: "Secret code is 42.",
              },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read file contents",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        max_tokens: 300,
      }),
    });

    const multiTurnData = (await multiTurnRes.json()) as any;
    if (multiTurnRes.ok && multiTurnData.content) {
      const text = multiTurnData.content.find((c: any) => c.type === "text")?.text;
      console.log(`✓ Multi-turn tool result test passed! Assistant reply:`, text?.trim());
    } else {
      throw new Error(`Multi-turn tool result failed: ${JSON.stringify(multiTurnData)}`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL 7 VERIFICATION TESTS PASSED SUCCESSFULLY!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e);
  process.exit(1);
});
