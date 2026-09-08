import crypto from "node:crypto";
import { SUPPORTED_MODELS, SKIP_THOUGHT_SIGNATURE } from "./constants";
import { AntigravityPayload } from "./antigravity-client";
import { cleanToolDeclarations } from "./schema-cleaner";

export class Transformer {
  /**
   * Resolve target model name in Antigravity API
   */
  public static resolveModel(requestedModel: string): string {
    const raw = (requestedModel || "").toLowerCase().trim();
    const clean = raw.replace(/^google\//, "").replace(/^antigravity-/, "");

    const found = SUPPORTED_MODELS.find(
      (m) => m.id === clean || m.name.toLowerCase() === raw || m.targetModel === clean
    );

    if (found && found.targetModel) {
      return found.targetModel;
    }
    if (found) {
      return found.id;
    }

    if (clean.includes("claude") && clean.includes("thinking") && !clean.includes("opus")) {
      return "claude-opus-4-6-thinking";
    }
    if (clean.includes("claude") && clean.includes("sonnet")) {
      return "claude-sonnet-4-6";
    }
    if (clean.includes("claude")) {
      return "claude-opus-4-6-thinking";
    }
    if (clean.includes("3.1-pro")) {
      return "gemini-3.1-pro-low";
    }
    if (clean.includes("3-pro")) {
      return "gemini-3-pro-low";
    }
    if (clean.includes("3.8-flash") || clean.includes("3.7-flash") || clean.includes("3-flash")) {
      return "gemini-3-flash";
    }

    return clean || "gemini-3-flash";
  }

  /**
   * Transform Anthropic /v1/messages request to Antigravity Payload
   */
  public static anthropicToAntigravity(body: any): AntigravityPayload {
    const targetModel = this.resolveModel(body.model);
    const contents: any[] = [];

    // System instruction
    let systemInstruction: any = undefined;
    if (body.system) {
      if (typeof body.system === "string") {
        systemInstruction = { parts: [{ text: body.system }] };
      } else if (Array.isArray(body.system)) {
        const textParts = body.system
          .map((s: any) => (typeof s === "string" ? s : s.text || ""))
          .filter(Boolean)
          .join("\n\n");
        if (textParts) {
          systemInstruction = { parts: [{ text: textParts }] };
        }
      }
    }

    // Collect tool names for ID correlation
    const toolNameMap = new Map<string, string>();
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item && item.type === "tool_use" && item.id && item.name) {
              toolNameMap.set(item.id, item.name);
            }
          }
        }
      }
    }

    // Messages conversion
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        const role = msg.role === "assistant" ? "model" : "user";
        const parts: any[] = [];

        if (typeof msg.content === "string") {
          if (msg.content.trim()) {
            parts.push({ text: msg.content });
          }
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (typeof item === "string") {
              if (item.trim()) {
                parts.push({ text: item });
              }
            } else if (item && item.type === "text") {
              if (typeof item.text === "string" && item.text.trim()) {
                parts.push({ text: item.text });
              }
            } else if (item && item.type === "image") {
              // Anthropic image
              if (item.source && item.source.data) {
                parts.push({
                  inlineData: {
                    mimeType: item.source.media_type || "image/jpeg",
                    data: item.source.data,
                  },
                });
              }
            } else if (item.type === "thinking" && item.thinking) {
              parts.push({
                thought: true,
                text: item.thinking,
                thoughtSignature: SKIP_THOUGHT_SIGNATURE,
                thought_signature: SKIP_THOUGHT_SIGNATURE,
              });
            } else if (item.type === "tool_use") {
              const callId = item.id || `call_${crypto.randomBytes(8).toString("hex")}`;
              parts.push({
                functionCall: {
                  id: callId,
                  name: item.name,
                  args: item.input || {},
                },
                thoughtSignature: SKIP_THOUGHT_SIGNATURE,
                thought_signature: SKIP_THOUGHT_SIGNATURE,
              });
            } else if (item.type === "tool_result") {
              let responseContent = item.content;
              if (typeof responseContent !== "string") {
                responseContent = JSON.stringify(responseContent);
              }
              const funcName = (item.tool_use_id ? toolNameMap.get(item.tool_use_id) : undefined) || "tool_result";
              parts.push({
                functionResponse: {
                  id: item.tool_use_id,
                  name: funcName,
                  response: { content: responseContent },
                },
              });
            }
          }
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }
      }
    }

    // Generation Config
    const generationConfig: any = {};
    if (typeof body.max_tokens === "number") {
      generationConfig.maxOutputTokens = body.max_tokens;
    }
    if (typeof body.temperature === "number") {
      generationConfig.temperature = body.temperature;
    }
    if (typeof body.top_p === "number") {
      generationConfig.topP = body.top_p;
    }
    if (Array.isArray(body.stop_sequences)) {
      generationConfig.stopSequences = body.stop_sequences;
    }

    // Thinking configuration
    const isClaude = targetModel.includes("claude");
    const isThinking = targetModel.includes("thinking") || targetModel.includes("gemini-3");

    if (isThinking) {
      let budget = 32768;
      if (body.thinking) {
        if (body.thinking.type === "disabled") {
          budget = 0;
        } else if (typeof body.thinking.budget_tokens === "number") {
          budget = body.thinking.budget_tokens;
        }
      }
      if (budget > 0) {
        generationConfig.thinkingConfig = {
          include_thoughts: true,
          thinking_budget: budget,
        };
        if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= budget) {
          generationConfig.maxOutputTokens = Math.max(64000, budget + 8192);
        }
      } else {
        generationConfig.thinkingConfig = {
          include_thoughts: false,
          thinking_budget: 0,
        };
      }
    }

    // Tools conversion
    let tools: any[] | undefined = undefined;
    let toolConfig: any = undefined;

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const cleaned = cleanToolDeclarations(body.tools);
      if (cleaned.length > 0) {
        tools = cleaned;
        if (isClaude) {
          toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
        }
      }
    }

    const mergedContents = this.mergeConsecutiveContents(contents);
    const sanitizedContents = this.sanitizeThoughtSignaturesInContents(mergedContents);

    return {
      model: targetModel,
      request: {
        contents: sanitizedContents,
        systemInstruction,
        generationConfig,
        ...(tools ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      },
    };
  }

  /**
   * Transform OpenAI /v1/chat/completions request to Antigravity Payload
   */
  public static openaiToAntigravity(body: any): AntigravityPayload {
    const targetModel = this.resolveModel(body.model);
    const contents: any[] = [];
    let systemInstruction: any = undefined;

    // Collect tool names for ID correlation
    const toolNameMap = new Map<string, string>();
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc && tc.id && tc.function?.name) {
              toolNameMap.set(tc.id, tc.function.name);
            }
          }
        }
      }
    }

    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === "system") {
          const sysText = String(msg.content || "").trim();
          if (sysText) {
            systemInstruction = { parts: [{ text: sysText }] };
          }
          continue;
        }

        const role = msg.role === "assistant" ? "model" : "user";
        const parts: any[] = [];

        if (msg.role !== "tool") {
          if (typeof msg.content === "string" && msg.content.trim()) {
            parts.push({ text: msg.content });
          } else if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (item && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
                parts.push({ text: item.text });
              } else if (item && item.type === "image_url" && item.image_url?.url) {
                const dataUrl = item.image_url.url;
                if (dataUrl.startsWith("data:")) {
                  const [header, b64] = dataUrl.split(",");
                  const mimeType = header.replace("data:", "").replace(";base64", "");
                  parts.push({
                    inlineData: { mimeType, data: b64 },
                  });
                }
              }
            }
          }
        }

        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc.function) {
              let args = {};
              try {
                args = JSON.parse(tc.function.arguments || "{}");
              } catch {}
              const callId = tc.id || `call_${crypto.randomBytes(8).toString("hex")}`;
              parts.push({
                functionCall: {
                  id: callId,
                  name: tc.function.name,
                  args,
                },
                thoughtSignature: SKIP_THOUGHT_SIGNATURE,
                thought_signature: SKIP_THOUGHT_SIGNATURE,
              });
            }
          }
        }

        if (msg.role === "tool") {
          const funcName = msg.name || (msg.tool_call_id ? toolNameMap.get(msg.tool_call_id) : undefined) || "tool_result";
          let responseContent = msg.content;
          if (typeof responseContent !== "string") {
            responseContent = JSON.stringify(responseContent);
          }
          parts.push({
            functionResponse: {
              id: msg.tool_call_id,
              name: funcName,
              response: { content: responseContent },
            },
          });
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }
      }
    }

    const generationConfig: any = {};
    if (typeof body.max_tokens === "number") {
      generationConfig.maxOutputTokens = body.max_tokens;
    }
    if (typeof body.temperature === "number") {
      generationConfig.temperature = body.temperature;
    }
    if (typeof body.top_p === "number") {
      generationConfig.topP = body.top_p;
    }

    const isClaude = targetModel.includes("claude");
    const isThinking = targetModel.includes("thinking") || targetModel.includes("gemini-3");

    if (isThinking) {
      let budget = 32768;
      const effort = String(body.reasoning_effort || body.extra_body?.reasoning_effort || "").toLowerCase();
      const reasoningTokens = body.reasoning_tokens || body.extra_body?.reasoning_tokens;

      if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
        budget = reasoningTokens;
      } else if (effort === "low" || effort === "minimal") {
        budget = 4096;
      } else if (effort === "medium") {
        budget = 16384;
      } else if (effort === "high" || effort === "xhigh" || effort === "max") {
        budget = 32768;
      } else if (effort === "none" || effort === "off" || effort === "disabled") {
        budget = 0;
      }

      if (budget > 0) {
        generationConfig.thinkingConfig = {
          include_thoughts: true,
          thinking_budget: budget,
        };
        if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= budget) {
          generationConfig.maxOutputTokens = Math.max(64000, budget + 8192);
        }
      } else {
        generationConfig.thinkingConfig = {
          include_thoughts: false,
          thinking_budget: 0,
        };
      }
    }

    let tools: any[] | undefined = undefined;
    let toolConfig: any = undefined;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const cleaned = cleanToolDeclarations(body.tools);
      if (cleaned.length > 0) {
        tools = cleaned;
        if (isClaude) {
          toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
        }
      }
    }

    const mergedContents = this.mergeConsecutiveContents(contents);
    const sanitizedContents = this.sanitizeThoughtSignaturesInContents(mergedContents);

    return {
      model: targetModel,
      request: {
        contents: sanitizedContents,
        systemInstruction,
        generationConfig,
        ...(tools ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      },
    };
  }

  /**
   * Merge consecutive contents with the same role into a single turn
   */
  public static mergeConsecutiveContents(contents: any[]): any[] {
    const merged: any[] = [];
    for (const item of contents) {
      if (!item || !item.parts || item.parts.length === 0) continue;
      if (merged.length > 0 && merged[merged.length - 1].role === item.role) {
        merged[merged.length - 1].parts.push(...item.parts);
      } else {
        merged.push({ role: item.role, parts: [...item.parts] });
      }
    }
    return merged;
  }

  /**
   * Sanitizes thought signatures in model contents to avoid 400 validation error in Gemini 3 models.
   * Google Antigravity requires the first functionCall in each model turn to have a thought_signature.
   */
  public static sanitizeThoughtSignaturesInContents(contents: any[]): any[] {
    if (!Array.isArray(contents)) return [];

    return contents.map((content) => {
      if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
        return content;
      }
      if (content.role !== "model") {
        return content;
      }

      let foundFirstFunctionCall = false;
      const sanitizedParts = content.parts.map((part: any) => {
        if (part && typeof part === "object") {
          if (part.thought === true || part.type === "thinking") {
            return {
              ...part,
              thoughtSignature: part.thoughtSignature || SKIP_THOUGHT_SIGNATURE,
              thought_signature: part.thought_signature || SKIP_THOUGHT_SIGNATURE,
            };
          }
          if (part.functionCall) {
            if (!foundFirstFunctionCall) {
              foundFirstFunctionCall = true;
              return {
                ...part,
                thoughtSignature: part.thoughtSignature || SKIP_THOUGHT_SIGNATURE,
                thought_signature: part.thought_signature || SKIP_THOUGHT_SIGNATURE,
              };
            } else {
              // Parallel function calls must not have a signature
              const cleanPart = { ...part };
              delete cleanPart.thoughtSignature;
              delete cleanPart.thought_signature;
              return cleanPart;
            }
          }
        }
        return part;
      });

      return {
        ...content,
        parts: sanitizedParts,
      };
    });
  }

  /**
   * Format Antigravity response to Anthropic Message response
   */
  public static antigravityToAnthropic(resp: any, originalModel: string): any {
    const raw = resp.response || resp;
    const candidates = raw.candidates || [];
    const candidate = candidates[0] || {};
    const parts = candidate.content?.parts || [];

    const contentBlocks: any[] = [];
    let stopReason = "end_turn";

    for (const part of parts) {
      if (part.thought === true) {
        contentBlocks.push({
          type: "thinking",
          thinking: part.text || "",
          signature: "antigravity_thought",
        });
      } else if (part.text) {
        contentBlocks.push({
          type: "text",
          text: part.text,
        });
      } else if (part.functionCall) {
        stopReason = "tool_use";
        contentBlocks.push({
          type: "tool_use",
          id: `call_${crypto.randomBytes(8).toString("hex")}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      }
    }

    if (candidate.finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }

    return {
      id: `msg_${crypto.randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      content: contentBlocks,
      model: originalModel,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: raw.usageMetadata?.promptTokenCount || 0,
        output_tokens: raw.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  /**
   * Format Antigravity response to OpenAI ChatCompletion response
   */
  public static antigravityToOpenAI(resp: any, originalModel: string): any {
    const raw = resp.response || resp;
    const candidate = raw.candidates?.[0] || {};
    const parts = candidate.content?.parts || [];

    let text = "";
    let reasoning = "";
    const toolCalls: any[] = [];
    let finishReason = "stop";

    for (const part of parts) {
      if (part.thought === true) {
        reasoning += part.text || "";
      } else if (part.text) {
        text += part.text;
      } else if (part.functionCall) {
        finishReason = "tool_calls";
        toolCalls.push({
          id: `call_${crypto.randomBytes(8).toString("hex")}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    if (candidate.finishReason === "MAX_TOKENS") {
      finishReason = "length";
    }

    const message: any = {
      role: "assistant",
      content: text,
    };
    if (reasoning) {
      message.reasoning_content = reasoning;
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: raw.usageMetadata?.promptTokenCount || 0,
        completion_tokens: raw.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: (raw.usageMetadata?.promptTokenCount || 0) + (raw.usageMetadata?.candidatesTokenCount || 0),
      },
    };
  }
}
