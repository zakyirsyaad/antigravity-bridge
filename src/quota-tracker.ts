import fs from "node:fs";
import path from "node:path";
import { USER_HOME, findModel } from "./constants";

const QUOTA_FILE = path.join(USER_HOME, ".zcode", "antigravity-quota.json");

export interface QuotaWindow {
  type: "five_hour" | "weekly";
  hitAt: string;           // ISO timestamp when we hit the limit
  resetsAt: string;        // ISO timestamp when it resets
  percentRemaining: number; // 0 = exhausted
  resetMessage: string;    // e.g. "Resets in 3h55m50s"
  family?: string;         // which model family earned it, when known
}

export interface QuotaBucket {
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
}

/**
 * Cooldowns are per (account, family).
 *
 * Antigravity meters Claude — served through Vertex — and Gemini out of
 * different buckets, so an exhausted Claude weekly quota says nothing about
 * Gemini. Recording it against the bare account parked every pooled account for
 * every model and left failover with nowhere to go, while Google's own meters
 * still read ~100%.
 *
 * `fiveHour` / `weekly` at the top level are the pre-2.0.3 shape: no family was
 * recorded, so they keep limiting everything.
 */
export interface QuotaState {
  perAccount: Record<string, QuotaBucket & {
    families?: Record<string, QuotaBucket>;
    lastUpdated: string;
  }>;
}

/**
 * Parse "Resets in Xh Ym Zs" or "Resets in Ym Zs" etc. from 429 error messages.
 * Returns epoch ms of when it resets, or null if not parseable.
 */
function parseResetDuration(message: string): number | null {
  // Match patterns like: "Resets in 3h55m50s", "Resets in 1h", "Resets in 30m", etc.
  const match = message.match(/[Rr]eset[s]?\s+in\s+((?:\d+h)?(?:\d+m)?(?:\d+s)?)/i);
  if (!match) return null;

  const raw = match[1];
  let totalSeconds = 0;

  const h = raw.match(/(\d+)h/);
  const m = raw.match(/(\d+)m/);
  const s = raw.match(/(\d+)s/);

  if (h) totalSeconds += parseInt(h[1]) * 3600;
  if (m) totalSeconds += parseInt(m[1]) * 60;
  if (s) totalSeconds += parseInt(s[1]);

  if (totalSeconds === 0) return null;
  return Date.now() + totalSeconds * 1000;
}

/**
 * Determine quota type from error message.
 * - "Individual quota reached" + reset < 6h → five_hour
 * - "Individual quota reached" + reset >= 6h → weekly
 * - "weekly" in message → weekly
 */
function detectWindowType(message: string, resetsAt: number): "five_hour" | "weekly" {
  const lc = message.toLowerCase();
  if (lc.includes("week")) return "weekly";
  const diffHours = (resetsAt - Date.now()) / 3600_000;
  return diffHours < 6 ? "five_hour" : "weekly";
}

export class QuotaTracker {
  private static instance: QuotaTracker;

  public static getInstance(): QuotaTracker {
    if (!QuotaTracker.instance) {
      QuotaTracker.instance = new QuotaTracker();
    }
    return QuotaTracker.instance;
  }

  private load(): QuotaState {
    try {
      if (fs.existsSync(QUOTA_FILE)) {
        return JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8"));
      }
    } catch {}
    return { perAccount: {} };
  }

  private save(state: QuotaState) {
    try {
      fs.writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch {}
  }

  /**
   * Call this whenever a 429 error is received.
   * @param email  The Google account email
   * @param errorMessage  The error message string from the 429 response
   */
  public record429(email: string, errorMessage: string, model?: string) {
    const resetsAtMs = parseResetDuration(errorMessage);
    if (!resetsAtMs) return; // can't parse, skip

    const windowType = detectWindowType(errorMessage, resetsAtMs);
    const now = new Date().toISOString();
    const resetsAt = new Date(resetsAtMs).toISOString();

    // Extract reset message
    const resetMsgMatch = errorMessage.match(/(Resets in [^.]+)/i);
    const resetMessage = resetMsgMatch ? resetMsgMatch[1] : "Quota exhausted";

    const state = this.load();
    if (!state.perAccount[email]) {
      state.perAccount[email] = { lastUpdated: now };
    }

    const window: QuotaWindow = {
      type: windowType,
      hitAt: now,
      resetsAt,
      percentRemaining: 0,
      resetMessage,
    };

    const family = model ? findModel(model)?.family : undefined;
    window.family = family;

    // An unknown model keeps the old account-wide behaviour: better to cool an
    // account we cannot classify than to keep hammering a limit.
    let bucket: QuotaBucket = state.perAccount[email];
    if (family) {
      const families = (state.perAccount[email].families ||= {});
      bucket = families[family] ||= {};
    }

    if (windowType === "five_hour") {
      bucket.fiveHour = window;
    } else {
      bucket.weekly = window;
    }
    state.perAccount[email].lastUpdated = now;

    this.save(state);
  }

  /**
   * Get quota state for a specific account (or all).
   * Also calculates percentRemaining based on how much time has elapsed since the 5h/weekly window.
   */
  public getQuota(email?: string): QuotaState {
    const state = this.load();
    const now = Date.now();

    for (const [acct, data] of Object.entries(state.perAccount)) {
      if (email && acct !== email) continue;

      const buckets: QuotaBucket[] = [data, ...Object.values(data.families || {})];
      for (const bucket of buckets)
      for (const key of ["fiveHour", "weekly"] as const) {
        const w = bucket[key];
        if (!w) continue;

        const resetsMs = new Date(w.resetsAt).getTime();
        const hitMs = new Date(w.hitAt).getTime();

        if (now >= resetsMs) {
          // Window has reset → remove stale entry
          delete bucket[key];
          continue;
        }

        // Calculate percentage remaining (time-based)
        const totalWindow = resetsMs - hitMs;
        const elapsed = now - hitMs;
        const remaining = Math.max(0, Math.min(100, Math.round(((totalWindow - elapsed) / totalWindow) * 100)));
        w.percentRemaining = remaining;
      }
    }

    return state;
  }

  public getQuotaForAccount(email: string) {
    const state = this.getQuota(email);
    return state.perAccount[email] || null;
  }

  /**
   * Check if an account is currently rate limited / cooling down.
   */
  public isAccountRateLimited(email: string, model?: string): boolean {
    const acct = this.getQuotaForAccount(email);
    if (!acct) return false;

    const family = model ? findModel(model)?.family : undefined;
    const families = acct.families || {};

    // The account-wide bucket still limits everything: it predates families, or
    // the model could not be classified.
    const buckets: QuotaBucket[] = [acct];
    if (model) {
      if (family && families[family]) buckets.push(families[family]);
    } else {
      // No model in hand — the dashboard asking whether anything is cooling.
      buckets.push(...Object.values(families));
    }

    const now = Date.now();
    return buckets.some(
      (bucket) =>
        (bucket.fiveHour && new Date(bucket.fiveHour.resetsAt).getTime() > now) ||
        (bucket.weekly && new Date(bucket.weekly.resetsAt).getTime() > now)
    );
  }

  /**
   * Get cooldown remaining info for an account
   */
  public getAccountCooldownRemaining(
    email: string,
    model?: string
  ): { remainingMs: number; resetMessage: string; resetsAt: string; family?: string } | null {
    const acct = this.getQuotaForAccount(email);
    if (!acct) return null;

    const family = model ? findModel(model)?.family : undefined;
    const families = acct.families || {};
    const scoped: QuotaBucket[] = model
      ? family && families[family]
        ? [families[family]]
        : []
      : Object.values(families);

    const now = Date.now();
    const windows = [acct.fiveHour, acct.weekly, ...scoped.flatMap((b) => [b.fiveHour, b.weekly])].filter(Boolean);
    let maxResetMs = 0;
    let maxWindow: QuotaWindow | null = null;

    for (const w of windows) {
      if (!w) continue;
      const r = new Date(w.resetsAt).getTime();
      if (r > now && r > maxResetMs) {
        maxResetMs = r;
        maxWindow = w;
      }
    }

    if (!maxWindow || maxResetMs <= now) return null;

    return {
      remainingMs: maxResetMs - now,
      resetMessage: maxWindow.resetMessage,
      resetsAt: maxWindow.resetsAt,
      family: maxWindow.family,
    };
  }

  /**
   * Manually clear cooldown for an account
   */
  public clearCooldown(email: string): void {
    const state = this.load();
    if (state.perAccount[email]) {
      delete state.perAccount[email].fiveHour;
      delete state.perAccount[email].weekly;
      delete state.perAccount[email].families;
      state.perAccount[email].lastUpdated = new Date().toISOString();
      this.save(state);
    }
  }
}
