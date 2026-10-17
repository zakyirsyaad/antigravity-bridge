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
 * Note that Google's ids and display names disagree in places — the retired
 * `gemini-3.5-flash-low` was presented as "Gemini 3.5 Flash (Medium)", and
 * `gemini-2.5-flash` is presented as "Gemini 3.5 Flash Lite". That inconsistency
 * is upstream; reproducing it faithfully beats inventing our own names.
 *
 * A listed id is not a served one: `bridge:models` reads the catalogue, and the
 * catalogue has kept dead ids, with full metadata, for weeks. Send every id you add
 * or keep one real request, and read the reply — see the 3.5 Flash note below.
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
   *
   * Absent means Google declares none, and such a model (the Flash Lites) does not
   * reason unless asked. The bridge then sends no thinkingConfig by default, and an
   * effort level only turns reasoning on when it is above the protocol's default.
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

  // No Gemini Pro model is served any more. `gemini-pro-agent` and `gemini-3.1-pro-low`
  // went 404 "Requested entity was not found" on 2026-10-17 and left the catalogue.
  // `gemini-2.5-pro` is still listed, but answers 503 "no capacity" on all six pooled
  // accounts, as it already did when the previous table was written, so a client offered
  // it gets a failure. Every pro
  // id is a retired alias of gemini-3.8-flash-tiered now (see Transformer.RETIRED_IDS);
  // put 2.5 Pro back here once a real request to it succeeds.
  //
  // The Gemini 3.6 Flash tiers (high/medium/low) went 404 the same day. The 3.5 Flash
  // tiers (`gemini-3-flash-agent`, `gemini-3.5-flash-low`, `gemini-3.5-flash-extra-low`)
  // are worse: still in the catalogue with full metadata, but every request gets HTTP 200
  // carrying one canned sentence — "Gemini 3.5 Flash is no longer available. Please
  // switch to Gemini 3.7 Flash..." — with no finishReason and no usage, which a client
  // shows as the model's answer. Neither `bridge:models` nor a status code reveals that;
  // only reading the reply does. Both families are retired aliases now.

  // Tiered flash models. These carry no displayName upstream because they are
  // not a fixed tier: Antigravity's own model picker maps its "flash" option to
  // gemini-3.8-flash-tiered and lets the user slide reasoning from low to high,
  // which is why the budget is dynamic. The tier is a per-request parameter, so
  // reasoning_effort / thinking.budget_tokens is how you choose it here.
  {
    id: "gemini-3.8-flash-tiered",
    name: "Gemini 3.8 Flash (Tiered)",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: -1,
    minThinkingBudget: 32,
  },
  // gemini-3.7-flash-tiered and gemini-3.6-flash-tiered were here until Google began
  // answering HTTP 404 "Requested entity was not found" for both (and dropped them from
  // its catalogue). They are retired aliases of the newest tiered model now.

  // Gemini 3 Flash
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65536,
    supportsThinking: true,
    thinkingBudget: -1,
    minThinkingBudget: 128,
  },

  // Flash Lite. Both can reason but declare no default budget, and with no
  // thinkingConfig they do not reason at all (measured: 0 thought tokens, against ~200
  // when sent -1), so the bridge sends none unless the caller asks; see ModelDef.
  // Google also lists gemini-2.5-flash, -2.5-flash-lite and -2.5-flash-thinking, all
  // with the display name "Gemini 3.5 Flash Lite" — they are retired aliases of 3.5 Flash
  // Lite here rather than three more names for it.
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    minThinkingBudget: 128,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    family: "gemini",
    contextLimit: 1048576,
    outputLimit: 65535,
    supportsThinking: true,
    minThinkingBudget: 128,
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
