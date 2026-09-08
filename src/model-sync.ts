import { SUPPORTED_MODELS, ModelDef } from "./constants";
import { OAuthManager } from "./oauth";

const FETCH_MODELS_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];
const LOAD_PROJECT_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

export interface UpstreamModel {
  id: string;
  displayName?: string;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  minThinkingBudget?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelDrift {
  /** In SUPPORTED_MODELS but no longer offered — requests to these will fail. */
  missing: ModelDef[];
  /** Offered and thinking-capable, but not exposed by the bridge. */
  unexposed: UpstreamModel[];
  /** Exposed, but our metadata disagrees with Google's. */
  changed: Array<{ id: string; field: string; ours: unknown; theirs: unknown }>;
  defaultAgentModelId?: string;
  totalUpstream: number;
}

async function postJson(url: string, token: string, body: object): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.18.3 Darwin/arm64",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return await response.json();
}

/** Ask Google which models it actually serves for this account. */
export async function fetchUpstreamModels(): Promise<{ models: Record<string, any>; defaultAgentModelId?: string }> {
  const oauth = OAuthManager.getInstance();
  const token = await oauth.getValidAccessToken();

  let project: string | undefined;
  try {
    const info = await postJson(LOAD_PROJECT_ENDPOINT, token, { metadata: { ideType: "ANTIGRAVITY" } });
    project = info.cloudaicompanionProject;
  } catch {
    // The models endpoint generally works without it.
  }

  const body = project ? { project } : {};
  let lastError: unknown;
  for (const endpoint of FETCH_MODELS_ENDPOINTS) {
    try {
      const data = await postJson(endpoint, token, body);
      return { models: data.models || {}, defaultAgentModelId: data.defaultAgentModelId };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not reach fetchAvailableModels");
}

/**
 * Compare SUPPORTED_MODELS against what Google serves.
 *
 * The table is a hand-maintained snapshot, and the last one rotted badly enough
 * that one id pointed at a model Google no longer offers while five others
 * collapsed onto a single target. This is how that gets caught early rather
 * than surfacing as an opaque failure mid-request.
 */
export async function checkModelDrift(): Promise<ModelDrift> {
  const { models, defaultAgentModelId } = await fetchUpstreamModels();

  const missing: ModelDef[] = [];
  const changed: ModelDrift["changed"] = [];

  for (const ours of SUPPORTED_MODELS) {
    const theirs = models[ours.id];
    if (!theirs) {
      missing.push(ours);
      continue;
    }
    const compare: Array<[string, unknown, unknown]> = [
      ["supportsThinking", ours.supportsThinking, !!theirs.supportsThinking],
      ["thinkingBudget", ours.thinkingBudget ?? null, theirs.thinkingBudget ?? null],
      ["minThinkingBudget", ours.minThinkingBudget ?? null, theirs.minThinkingBudget ?? null],
      ["outputLimit", ours.outputLimit, theirs.maxOutputTokens ?? ours.outputLimit],
      ["contextLimit", ours.contextLimit, theirs.maxTokens ?? ours.contextLimit],
    ];
    for (const [field, a, b] of compare) {
      if (a !== b) changed.push({ id: ours.id, field, ours: a, theirs: b });
    }
  }

  const exposed = new Set(SUPPORTED_MODELS.map((m) => m.id));
  const unexposed: UpstreamModel[] = [];
  for (const [id, m] of Object.entries<any>(models)) {
    // Skip Google's internal entries: they carry no display name and are not
    // addressable as chat models.
    if (!m.displayName || id.startsWith("chat_") || id.startsWith("tab_")) continue;
    if (exposed.has(id) || !m.supportsThinking) continue;
    unexposed.push({
      id,
      displayName: m.displayName,
      supportsThinking: true,
      thinkingBudget: m.thinkingBudget,
      minThinkingBudget: m.minThinkingBudget,
      maxTokens: m.maxTokens,
      maxOutputTokens: m.maxOutputTokens,
    });
  }

  return { missing, unexposed, changed, defaultAgentModelId, totalUpstream: Object.keys(models).length };
}
