import { AccountToken } from "./oauth";

const LOAD_PROJECT_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];
const SUMMARY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];

export interface QuotaWindow {
  remainingPercent: number;
  resetAt: string;
  window: string;
}

export interface AccountQuota {
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  subscriptionTier?: string;
}

interface QuotaBucket {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  displayName?: string;
  description?: string;
}

interface QuotaSummaryResponse {
  groups?: Array<{ buckets?: QuotaBucket[] }>;
}

async function postJson<T>(url: string, token: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.18.3 Darwin/arm64",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Quota API ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function classifyGeminiWindow(bucket: QuotaBucket): "fiveHour" | "weekly" | null {
  const value = `${bucket.window || ""} ${bucket.bucketId || ""} ${bucket.displayName || ""} ${bucket.description || ""}`.toLowerCase();
  if (!value.includes("gemini")) return null;
  if (value.includes("week")) return "weekly";
  if (value.includes("5h") || value.includes("five") || value.includes("hour")) {
    return "fiveHour";
  }
  return null;
}

function readSummary(data: QuotaSummaryResponse): AccountQuota {
  const result: AccountQuota = { fiveHour: null, weekly: null };
  for (const group of data.groups || []) {
    for (const bucket of group.buckets || []) {
      const key = classifyGeminiWindow(bucket);
      if (!key || !bucket.resetTime) continue;
      result[key] = {
        remainingPercent: Math.max(
          0,
          Math.min(100, Math.round((bucket.remainingFraction ?? 0) * 100)),
        ),
        resetAt: bucket.resetTime,
        window: bucket.window || bucket.displayName || key,
      };
    }
  }
  return result;
}

export class QuotaService {
  public static async fetchQuota(account: AccountToken): Promise<AccountQuota> {
    const token = account.accessToken;
    if (!token) throw new Error("Account has no access token");

    let project: string | undefined;
    let subscriptionTier: string | undefined;
    try {
      const projectInfo = await postJson<{
        cloudaicompanionProject?: string;
        paidTier?: { id?: string };
        currentTier?: { id?: string };
      }>(LOAD_PROJECT_ENDPOINT, token, { metadata: { ideType: "ANTIGRAVITY" } });
      project = projectInfo.cloudaicompanionProject;
      subscriptionTier = projectInfo.paidTier?.id || projectInfo.currentTier?.id;
    } catch {
      // The quota endpoint can still work without a project fallback.
    }

    const body = project ? { project } : {};
    let lastError: unknown;
    for (const endpoint of QUOTA_ENDPOINTS) {
      try {
        await postJson(endpoint, token, body);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError && !SUMMARY_ENDPOINTS.length) throw lastError;

    for (const endpoint of SUMMARY_ENDPOINTS) {
      try {
        const summary = await postJson<QuotaSummaryResponse>(endpoint, token, body);
        const result = { ...readSummary(summary), subscriptionTier };
        if (account.email) {
          QuotaService.quotaCache.set(account.email, { quota: result, timestamp: Date.now() });
        }
        return result;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Quota lookup failed");
  }

  private static quotaCache = new Map<string, { quota: AccountQuota; timestamp: number }>();

  /**
   * Get quota from cache if fresh (within maxAgeMs), otherwise fetch live from Google
   */
  public static async getCachedQuota(
    account: AccountToken,
    maxAgeMs = 45_000
  ): Promise<AccountQuota | null> {
    const key = account.email || account.refreshToken;
    const cached = this.quotaCache.get(key);
    if (cached && Date.now() - cached.timestamp < maxAgeMs) {
      return cached.quota;
    }
    try {
      return await this.fetchQuota(account);
    } catch {
      return cached ? cached.quota : null;
    }
  }

  public static getFastCachedQuota(email: string): AccountQuota | null {
    return this.quotaCache.get(email)?.quota || null;
  }
}
