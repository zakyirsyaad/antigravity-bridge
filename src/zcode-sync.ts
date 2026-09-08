import fs from "node:fs";
import path from "node:path";
import { ZCODE_CONFIG_PATH, BRIDGE_BASE_URL, SUPPORTED_MODELS } from "./constants";

export const ANTIGRAVITY_PROVIDER_KEY = "antigravity-oauth-bridge";

export function syncZCodeConfig(): { success: boolean; configPath: string; error?: string } {
  try {
    if (!fs.existsSync(ZCODE_CONFIG_PATH)) {
      const dirname = path.dirname(ZCODE_CONFIG_PATH);
      if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, { recursive: true });
      }
      fs.writeFileSync(ZCODE_CONFIG_PATH, JSON.stringify({ provider: {} }, null, 2), "utf-8");
    }

    // Read existing config
    const raw = fs.readFileSync(ZCODE_CONFIG_PATH, "utf-8");
    let config: any = {};
    try {
      config = JSON.parse(raw);
    } catch {
      config = { provider: {} };
    }

    if (!config.provider || typeof config.provider !== "object") {
      config.provider = {};
    }

    // Create backup
    const backupPath = `${ZCODE_CONFIG_PATH}.backup.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.writeFileSync(backupPath, raw, "utf-8");

    // Build models map
    const modelsMap: Record<string, any> = {};

    for (const model of SUPPORTED_MODELS) {
      const modelEntry: any = {
        name: model.name,
        limit: {
          context: model.contextLimit,
          output: model.outputLimit,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        zcode: {
          modified: false,
          priority: model.id.includes("opus") ? 1 : model.id.includes("sonnet") ? 2 : 10,
        },
      };

      if (model.supportsThinking) {
        modelEntry.reasoning = {
          enabled: true,
          variants: model.family === "claude" ? ["low", "high", "max"] : ["low", "high"],
          defaultVariant: model.family === "claude" ? "high" : (model.thinkingLevel || "low"),
        };
      }

      modelsMap[model.id] = modelEntry;
    }

    // Provider definition
    config.provider[ANTIGRAVITY_PROVIDER_KEY] = {
      name: "Google Antigravity (OAuth)",
      kind: "anthropic",
      options: {
        apiKey: "antigravity-oauth-local",
        baseURL: BRIDGE_BASE_URL,
        apiKeyRequired: false,
      },
      enabled: true,
      source: "custom",
      models: modelsMap,
    };

    fs.writeFileSync(ZCODE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    return { success: true, configPath: ZCODE_CONFIG_PATH };
  } catch (e: any) {
    return { success: false, configPath: ZCODE_CONFIG_PATH, error: e.message };
  }
}
