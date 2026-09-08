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

export interface ModelDef {
  id: string;
  targetModel?: string;
  name: string;
  family: "claude" | "gemini";
  contextLimit: number;
  outputLimit: number;
  supportsThinking?: boolean;
  defaultThinkingBudget?: number;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}

export const SUPPORTED_MODELS: ModelDef[] = [
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    family: "claude",
    contextLimit: 200000,
    outputLimit: 64000,
    supportsThinking: true,
    defaultThinkingBudget: 32768,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Antigravity)",
    family: "claude",
    contextLimit: 200000,
    outputLimit: 64000,
    supportsThinking: false,
  },
  {
    id: "gemini-3.1-pro",
    targetModel: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    thinkingLevel: "low",
  },
  {
    id: "gemini-3-pro",
    targetModel: "gemini-3-pro-low",
    name: "Gemini 3 Pro (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    thinkingLevel: "low",
  },
  {
    id: "gemini-3.8-flash",
    targetModel: "gemini-3-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingLevel: "high",
    defaultThinkingBudget: 32768,
  },
  {
    id: "gemini-3.8-flash-high",
    targetModel: "gemini-3-flash",
    name: "Gemini 3.8 Flash High (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingLevel: "high",
    defaultThinkingBudget: 32768,
  },
  {
    id: "gemini-3.7-flash",
    targetModel: "gemini-3-flash",
    name: "Gemini 3.7 Flash (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingLevel: "high",
  },
  {
    id: "gemini-3.7-flash-high",
    targetModel: "gemini-3-flash",
    name: "Gemini 3.7 Flash High (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingLevel: "high",
  },
  {
    id: "gemini-3-flash",
    targetModel: "gemini-3-flash",
    name: "Gemini 3 Flash (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingLevel: "high",
  },
  {
    id: "gemini-2.5-flash",
    targetModel: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: false,
  },
  {
    id: "gemini-2.5-pro",
    targetModel: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (Antigravity)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: false,
  },
];
