import fs from "node:fs";
import path from "node:path";
import { USER_HOME } from "./constants";

export interface ModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  lastUsed: string;
}

export interface UsageReport {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThoughtsTokens: number;
  firstUsed: string;
  lastUsed: string;
  byModel: Record<string, ModelUsage>;
}

const USAGE_FILE_PATH = path.join(USER_HOME, ".zcode", "antigravity-usage.json");

export class UsageTracker {
  private static instance: UsageTracker;

  public static getInstance(): UsageTracker {
    if (!UsageTracker.instance) {
      UsageTracker.instance = new UsageTracker();
    }
    return UsageTracker.instance;
  }

  public getUsage(): UsageReport {
    try {
      if (fs.existsSync(USAGE_FILE_PATH)) {
        return JSON.parse(fs.readFileSync(USAGE_FILE_PATH, "utf-8"));
      }
    } catch {}

    return {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThoughtsTokens: 0,
      firstUsed: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      byModel: {},
    };
  }

  public recordUsage(model: string, inputTokens: number = 0, outputTokens: number = 0, thoughtsTokens: number = 0) {
    try {
      const usage = this.getUsage();
      const now = new Date().toISOString();

      usage.totalRequests += 1;
      usage.totalInputTokens += inputTokens;
      usage.totalOutputTokens += outputTokens;
      usage.totalThoughtsTokens += thoughtsTokens;
      usage.lastUsed = now;

      if (!usage.byModel[model]) {
        usage.byModel[model] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          thoughtsTokens: 0,
          lastUsed: now,
        };
      }

      usage.byModel[model].requests += 1;
      usage.byModel[model].inputTokens += inputTokens;
      usage.byModel[model].outputTokens += outputTokens;
      usage.byModel[model].thoughtsTokens += thoughtsTokens;
      usage.byModel[model].lastUsed = now;

      const dir = path.dirname(USAGE_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(USAGE_FILE_PATH, JSON.stringify(usage, null, 2), "utf-8");
    } catch {
      // Ignore write errors
    }
  }
}
