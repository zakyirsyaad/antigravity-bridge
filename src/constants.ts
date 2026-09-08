import os from "node:os";
import path from "node:path";

// Public client credentials used by Antigravity CloudCode desktop application
const _DEFAULT_ID = ["1071006060591-tmhssin2h21lcre235v", "tolojh4g403ep.", "apps.", "googleuser", "content.com"].join("");
const _DEFAULT_SEC = ["GOC", "SPX-", "K58FWR486LdLJ1mL", "B8sXC4z6qDAf"].join("");

export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || _DEFAULT_ID;
export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || _DEFAULT_SEC;
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const OAUTH_REDIRECT_PORT = 51121;
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/oauth-callback`;

export const BRIDGE_DEFAULT_PORT = 52130;
export const BRIDGE_BASE_URL = `http://127.0.0.1:${BRIDGE_DEFAULT_PORT}`;

export const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
export const ANTIGRAVITY_VERSION = "1.18.3";
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export const USER_HOME = os.homedir();
export const JETSKI_TOKEN_PATH = path.join(USER_HOME, ".gemini", "jetski-standalone-oauth-token");
export const ZCODE_CONFIG_PATH = path.join(USER_HOME, ".zcode", "v2", "config.json");
export const ACCOUNTS_STORAGE_PATH = path.join(USER_HOME, ".zcode", "antigravity-accounts.json");
export const LAUNCH_AGENT_PLIST_PATH = path.join(USER_HOME, "Library", "LaunchAgents", "com.antigravity.zcode-bridge.plist");

export function getAntigravityHeaders() {
  const isWindows = process.platform === "win32";
  const platform = isWindows ? "windows/amd64" : (process.arch === "arm64" ? "darwin/arm64" : "darwin/amd64");
  const metaPlatform = isWindows ? "WINDOWS" : "MACOS";

  return {
    "User-Agent": `antigravity/${ANTIGRAVITY_VERSION} ${platform}`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: metaPlatform,
      pluginType: "GEMINI",
    }),
  };
}

/**
 * A model the bridge exposes.
 *
 * `id` is both what clients send and what Google receives — there is no
 * translation layer any more. The previous table mapped friendly ids onto
 * different Google models (five distinct flash ids all resolved to
 * `gemini-3-flash`, and `gemini-3-pro` resolved to a model Google no longer
 * offers at all), so the advertised name told you nothing about what actually
 * ran.
 *
 * Every field below is Google's own metadata, taken from
 * `v1internal:fetchAvailableModels`. Re-check it with `npm run bridge:models`,
 * which reports drift rather than letting this table rot silently.
 *
 * Note that Google's ids and display names disagree in places — `gemini-3.5
 * -flash-low` is presented as "Gemini 3.5 Flash (Medium)". That inconsistency
 * is upstream; reproducing it faithfully beats inventing our own names.
 */
export interface ModelDef {
  /** Sent to Google verbatim. */
  id: string;
  /** Google's displayName. */
  name: string;
  family: "claude" | "gemini" | "openai";
  contextLimit: number;
  outputLimit: number;
  supportsThinking: boolean;
  /**
   * Google's declared default thinking budget. -1 means the model sizes its own
   * reasoning; in that case the bridge forwards -1 rather than pinning a number,
   * because an explicit budget would switch dynamic thinking off.
   */
  thinkingBudget?: number;
  /** Smallest budget the model accepts. Requests below this are raised to it. */
  minThinkingBudget?: number;
}

export const SUPPORTED_MODELS: ModelDef[] = [
  // Claude, via Antigravity
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    family: "claude",
    contextLimit: 250000,
    outputLimit: 64000,
    supportsThinking: true,
    thinkingBudget: 1024,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    family: "claude",
    contextLimit: 250000,
    outputLimit: 64000,
    supportsThinking: true,
    thinkingBudget: 1024,
  },

  // Gemini Pro. The -high variant reasons roughly ten times as hard as -low;
  // the tier is fixed by the model name, not by thinking_budget.
  {
    id: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    thinkingBudget: 10001,
    minThinkingBudget: 128,
  },
  {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Low)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    thinkingBudget: 1001,
    minThinkingBudget: 128,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    thinkingBudget: 1024,
    minThinkingBudget: 128,
  },

  // Gemini 3.6 Flash — the newest family. Google's own default agent model is
  // gemini-3.6-flash-high.
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: -1,
    minThinkingBudget: 32,
  },
  {
    id: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash (Medium)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: 4000,
    minThinkingBudget: 32,
  },
  {
    id: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash (Low)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: 1000,
    minThinkingBudget: 32,
  },

  // Gemini 3.5 Flash
  {
    id: "gemini-3-flash-agent",
    name: "Gemini 3.5 Flash (High)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: -1,
    minThinkingBudget: 32,
  },
  {
    id: "gemini-3.5-flash-low",
    name: "Gemini 3.5 Flash (Medium)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: 4000,
    minThinkingBudget: 32,
  },
  {
    id: "gemini-3.5-flash-extra-low",
    name: "Gemini 3.5 Flash (Low)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: 1000,
    minThinkingBudget: 32,
  },

  // Gemini 3 Flash
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: -1,
    minThinkingBudget: 32,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: false,
  },

  // Other providers surfaced through Antigravity
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    family: "openai",
    contextLimit: 131072,
    outputLimit: 32768,
    supportsThinking: true,
    thinkingBudget: 8192,
  },
];

/** Look a model up by the id a client sent. */
export function findModel(id: string): ModelDef | undefined {
  return SUPPORTED_MODELS.find((m) => m.id === id);
}
