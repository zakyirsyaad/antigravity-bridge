/**
 * Gemini Web Tool Prompt Bridge.
 *
 * Adapts client function declarations and tool calling to Gemini Web's conversational
 * interface using prompt injection, JSON schema folding, and lenient response parsing
 * (inspired by gemini-web-to-api).
 */

import crypto from "node:crypto";
import { parseOrRepairJson, extractJsonSubstring } from "./json-repair";

export interface ToolBridgeResult {
  content: string;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  finish_reason: "stop" | "tool_calls";
  /** Why calls the model wrote were left out (undeclared, forbidden by tool_choice, bad arguments). */
  dropped: string[];
}

/**
 * Formats tool definitions into readable prompt descriptions.
 */
export function formatToolsForPrompt(tools: any[]): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const lines: string[] = [];
  for (const t of tools) {
    const fn = t.function || t;
    const name = String(fn.name || "").trim();
    if (!name) continue;

    let desc = fn.description ? ` | description: ${fn.description.trim()}` : "";
    let paramsStr = "";
    if (fn.parameters && typeof fn.parameters === "object") {
      paramsStr = ` | parameters: ${JSON.stringify(fn.parameters)}`;
    } else if (fn.input_schema && typeof fn.input_schema === "object") {
      paramsStr = ` | parameters: ${JSON.stringify(fn.input_schema)}`;
    }

    lines.push(`- name: ${name}${desc}${paramsStr}`);
  }

  return lines.join("\n");
}

/**
 * Both protocols' tool_choice as one shape. OpenAI: "auto" | "none" | "required" |
 * {function: {name}}. Anthropic: {type: "auto" | "any" | "none"} | {type: "tool", name}.
 */
export function normalizeToolChoice(toolChoice: any): { mode: "auto" | "none" | "required"; name?: string } {
  if (typeof toolChoice === "string") {
    const mode = toolChoice.toLowerCase();
    return { mode: mode === "none" || mode === "required" ? mode : "auto" };
  }
  if (!toolChoice || typeof toolChoice !== "object") return { mode: "auto" };
  if (toolChoice.function?.name) return { mode: "required", name: String(toolChoice.function.name) };
  if (toolChoice.type === "tool" && toolChoice.name) return { mode: "required", name: String(toolChoice.name) };
  if (toolChoice.type === "any") return { mode: "required" };
  if (toolChoice.type === "none") return { mode: "none" };
  return { mode: "auto" };
}

/**
 * Builds the complete tool bridge prompt instructing the model to respond in JSON.
 */
export function buildToolBridgePrompt(
  conversationPrompt: string,
  tools: any[],
  toolChoice?: any
): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return conversationPrompt;
  }

  const toolList = formatToolsForPrompt(tools);
  const { mode: choiceMode, name: forcedName } = normalizeToolChoice(toolChoice);

  let choiceInstruction = "";
  if (forcedName) {
    choiceInstruction = `- You must return exactly one tool call with name: "${forcedName}".\n`;
  } else if (choiceMode === "required") {
    choiceInstruction = "- You must return at least one tool call in the tool_calls array.\n";
  } else if (choiceMode === "none") {
    choiceInstruction = '- Tool calling disabled. Return only {"content": "..."}.\n';
  }

  return `You are an AI assistant running behind an API gateway with tool-calling capabilities.
You MUST respond with valid JSON only. Do not output markdown code fences or commentary outside the JSON.

Output format schema:
{"tool_calls": [{"name": "<tool_name>", "arguments": {<parameters>}}]}
OR
{"content": "<conversational_response>"}

Rules:
- If a tool is required to fulfill the user's request, output the "tool_calls" array.
- Use only tool names declared in the Available Tools section below.
- "arguments" must be a valid JSON object matching the tool's parameters schema.
- If no tool call is needed, return {"content": "<your reply here>"}.
${choiceInstruction}
Available Tools:
${toolList}

Conversation History & Task:
${conversationPrompt}`;
}

/**
 * Parses the raw text output from Gemini Web, extracting tool calls or content text.
 */
/**
 * Gemini Web's raw text as content or tool calls, held to what the request allows: only
 * declared tools, nothing under tool_choice "none", only the forced tool when one is
 * named, and arguments that are a JSON object (repaired, so every protocol sends the same
 * valid JSON). A prompt is a request, not a contract: before this, any call the model
 * wrote went out as a real one, including to tools the client never declared.
 */
export function parseToolBridgeOutput(rawText: string, availableTools?: any[], toolChoice?: any): ToolBridgeResult {
  const loose = parseToolCallsLoosely(rawText);
  if (loose.tool_calls.length === 0) return loose;

  const declared = declaredToolNames(availableTools);
  const { mode, name: forced } = normalizeToolChoice(toolChoice);
  const dropped: string[] = [];
  const kept: ToolBridgeResult["tool_calls"] = [];
  for (const tc of loose.tool_calls) {
    const name = tc.function.name;
    if (mode === "none") {
      dropped.push(`${name}: tool_choice is none`);
      continue;
    }
    if (declared && !declared.has(name)) {
      dropped.push(`${name}: not a declared tool`);
      continue;
    }
    if (forced && name !== forced) {
      dropped.push(`${name}: tool_choice requires ${forced}`);
      continue;
    }
    const args = objectArguments(tc.function.arguments);
    if (args === null) {
      dropped.push(`${name}: arguments are not a JSON object`);
      continue;
    }
    kept.push({ ...tc, function: { name, arguments: args } });
  }
  return kept.length > 0
    ? { content: "", tool_calls: kept, finish_reason: "tool_calls", dropped }
    : { content: "", tool_calls: [], finish_reason: "stop", dropped };
}

/** The tool names a request declares, in either protocol's shape; null when it declares none. */
function declaredToolNames(tools?: any[]): Set<string> | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return new Set(tools.map((t) => String((t?.function || t)?.name || "").trim()).filter(Boolean));
}

/** Arguments as a JSON object string, or null when they are not an object (Anthropic's input must be one). */
function objectArguments(raw: string): string | null {
  // The repairer turns any text into something; a bare string ("/etc/hosts") came back as
  // {}, a call with its one argument silently gone. Only text that opens an object counts.
  if (!raw.trim().startsWith("{")) return null;
  const value = parseOrRepairJson<any>(raw, undefined);
  return value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : null;
}

/** Tool calls read leniently out of the model's text, before the request's rules are applied. */
function parseToolCallsLoosely(rawText: string): ToolBridgeResult {
  const result: ToolBridgeResult = {
    content: "",
    tool_calls: [],
    finish_reason: "stop",
    dropped: [],
  };

  if (!rawText || typeof rawText !== "string") {
    return result;
  }

  const trimmed = rawText.trim();
  const parsed = parseOrRepairJson<any>(trimmed, null);

  // 1. Direct JSON output with tool_calls array
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      for (const tc of parsed.tool_calls) {
        const name = String(tc.name || tc.function?.name || "").trim();
        if (name) {
          const argsObj = tc.arguments || tc.args || tc.function?.arguments || {};
          const argsStr = typeof argsObj === "string" ? argsObj : JSON.stringify(argsObj);
          result.tool_calls.push({
            id: `call_${crypto.randomBytes(8).toString("hex")}`,
            type: "function",
            function: {
              name,
              arguments: argsStr,
            },
          });
        }
      }
      if (result.tool_calls.length > 0) {
        result.finish_reason = "tool_calls";
        return result;
      }
    }

    // Single tool call object format: {"name": "...", "arguments": {...}}
    if (parsed.name && (parsed.arguments || parsed.args)) {
      const name = String(parsed.name).trim();
      const argsObj = parsed.arguments || parsed.args || {};
      const argsStr = typeof argsObj === "string" ? argsObj : JSON.stringify(argsObj);
      result.tool_calls.push({
        id: `call_${crypto.randomBytes(8).toString("hex")}`,
        type: "function",
        function: {
          name,
          arguments: argsStr,
        },
      });
      result.finish_reason = "tool_calls";
      return result;
    }

    // Direct content property
    if (typeof parsed.content === "string") {
      result.content = parsed.content;
      return result;
    }
  }

  // 2. Regex scan for embedded tool_calls or function objects in text
  // Only a gate for the extraction below. The regex it replaces was tried from every "{"
  // and scanned to the end of the text, quadratic on a long brace-heavy reply (code).
  const toolCallMatch = /"(?:tool_calls|functionCall)"\s*:/.test(trimmed) || /\{\s*"name"\s*:\s*"/.test(trimmed);

  if (toolCallMatch) {
    try {
      const extractedJson = extractJsonSubstring(trimmed);
      if (extractedJson) {
        const repairedObj = parseOrRepairJson<any>(extractedJson, null);
        if (repairedObj && Array.isArray(repairedObj.tool_calls)) {
          for (const tc of repairedObj.tool_calls) {
            if (tc.name) {
              result.tool_calls.push({
                id: `call_${crypto.randomBytes(8).toString("hex")}`,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
                },
              });
            }
          }
          if (result.tool_calls.length > 0) {
            result.finish_reason = "tool_calls";
            return result;
          }
        }
      }
    } catch {}
  }

  // 3. Fallback: standard conversational response text
  result.content = trimmed;
  result.finish_reason = "stop";
  return result;
}
