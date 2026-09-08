import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  OAUTH_REDIRECT_PORT,
  OAUTH_REDIRECT_URI,
  DEFAULT_PROJECT_ID,
  JETSKI_TOKEN_PATH,
  ACCOUNTS_STORAGE_PATH,
  ANTIGRAVITY_ENDPOINTS,
  getAntigravityHeaders,
} from "./constants";
import { QuotaTracker } from "./quota-tracker";

export interface PoolEvent {
  id: string;
  timestamp: string;
  type: "failover" | "switch" | "cooldown" | "recovered" | "info";
  message: string;
  fromAccount?: string;
  toAccount?: string;
  reason?: string;
}

export interface AccountToken {
  name?: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // timestamp in ms
  projectId?: string;
}

export interface AccountsStorage {
  accounts: AccountToken[];
  activeAccountIndex: number;
}

/**
 * Account fields that are safe to serialize over HTTP.
 *
 * The management API is unauthenticated, so anything reachable from it must
 * never carry OAuth material: a refresh token does not expire and grants
 * cloud-platform scope. Keep accessToken/refreshToken out of this type.
 */
export interface PublicAccountSummary {
  email?: string;
  name?: string;
  projectId?: string;
}

export function toPublicAccountSummary(account: AccountToken | null): PublicAccountSummary | null {
  if (!account) return null;
  return { email: account.email, name: account.name, projectId: account.projectId };
}

function base64URLEncode(str: Buffer): string {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function sha256(buffer: string | Buffer): Buffer {
  return crypto.createHash("sha256").update(buffer).digest();
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(sha256(verifier));
  return { verifier, challenge };
}

let memoryToken: AccountToken | null = null;

export class OAuthManager {
  private static instance: OAuthManager;
  /**
   * In-flight token refreshes, keyed by refresh token.
   *
   * Keyed rather than single, because the active account can change under us:
   * a 429 failover swaps it mid-flight, and a single shared promise would hand
   * the new account's caller the previous account's access token.
   */
  private refreshPromises = new Map<string, Promise<string>>();
  private autoFailoverEnabled: boolean = true;
  private poolEvents: PoolEvent[] = [];

  public static getInstance(): OAuthManager {
    if (!OAuthManager.instance) {
      OAuthManager.instance = new OAuthManager();
    }
    return OAuthManager.instance;
  }

  /**
   * Read the accounts file, always returning a well-formed shape.
   *
   * A truncated write, or the `{ provider: {} }`-shaped file this codebase
   * writes elsewhere, parses fine as JSON but has no `accounts` array — and
   * callers that dereferenced it directly threw a TypeError outside their
   * try/catch, or silently failed to persist.
   */
  private readStorage(): AccountsStorage {
    try {
      const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8"));
      return {
        accounts: Array.isArray(parsed?.accounts) ? parsed.accounts : [],
        activeAccountIndex: typeof parsed?.activeAccountIndex === "number" ? parsed.activeAccountIndex : 0,
      };
    } catch {
      return { accounts: [], activeAccountIndex: 0 };
    }
  }

  /**
   * Load token from Jetski or Accounts storage
   */
  public loadSavedAccount(): AccountToken | null {
    // Try ~/.zcode/antigravity-accounts.json first
    try {
      if (fs.existsSync(ACCOUNTS_STORAGE_PATH)) {
        const data: AccountsStorage = JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8"));
        if (data.accounts && data.accounts.length > 0) {
          const acc = data.accounts[data.activeAccountIndex ?? 0] || data.accounts[0];
          if (acc.refreshToken) {
            memoryToken = acc;
            return acc;
          }
        }
      }
    } catch {
      // Ignore
    }

    if (memoryToken && memoryToken.refreshToken) {
      return memoryToken;
    }

    // Try ~/.gemini/jetski-standalone-oauth-token
    try {
      if (fs.existsSync(JETSKI_TOKEN_PATH)) {
        const raw = JSON.parse(fs.readFileSync(JETSKI_TOKEN_PATH, "utf-8"));
        const tokenObj = raw.token || {};
        if (tokenObj.refresh_token) {
          const acc: AccountToken = {
            accessToken: tokenObj.access_token || "",
            refreshToken: tokenObj.refresh_token,
            expiresAt: tokenObj.expiry ? new Date(tokenObj.expiry).getTime() : 0,
            projectId: DEFAULT_PROJECT_ID,
          };
          memoryToken = acc;
          return acc;
        }
      }
    } catch {
      // Ignore
    }

    return null;
  }

  /**
   * Save account token to storage
   */
  public saveAccount(token: AccountToken) {
    memoryToken = token;
    try {
      const dir = fs.realpathSync(fs.existsSync(ACCOUNTS_STORAGE_PATH) ? ACCOUNTS_STORAGE_PATH : "");
    } catch {
      // ignore
    }

    try {
      const dirname = require("node:path").dirname(ACCOUNTS_STORAGE_PATH);
      if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, { recursive: true });
      }

      const storage: AccountsStorage = fs.existsSync(ACCOUNTS_STORAGE_PATH)
        ? this.readStorage()
        : { accounts: [], activeAccountIndex: 0 };

      const existingIdx = storage.accounts.findIndex(
        (a) => (token.email && a.email === token.email) || a.refreshToken === token.refreshToken
      );

      if (existingIdx >= 0) {
        storage.accounts[existingIdx] = token;
        storage.activeAccountIndex = existingIdx;
      } else {
        storage.accounts.push(token);
        storage.activeAccountIndex = storage.accounts.length - 1;
      }

      fs.writeFileSync(ACCOUNTS_STORAGE_PATH, JSON.stringify(storage, null, 2), "utf-8");
    } catch (e) {
      console.warn("Failed to persist accounts to storage file:", e);
    }
  }

  /**
   * List all stored Google accounts
   */
  public listAccounts(): { accounts: AccountToken[]; activeIndex: number } {
    try {
      if (fs.existsSync(ACCOUNTS_STORAGE_PATH)) {
        const storage: AccountsStorage = JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8"));
        return {
          accounts: storage.accounts || [],
          activeIndex: storage.activeAccountIndex || 0,
        };
      }
    } catch {}

    const saved = this.loadSavedAccount();
    return {
      accounts: saved ? [saved] : [],
      activeIndex: 0,
    };
  }

  /**
   * Switch active account by email or index
   */
  public switchAccount(identifier: string | number): AccountToken {
    if (!fs.existsSync(ACCOUNTS_STORAGE_PATH)) {
      throw new Error("No saved accounts found in storage.");
    }

    const storage: AccountsStorage = JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8"));
    if (!storage.accounts || storage.accounts.length === 0) {
      throw new Error("No saved accounts found.");
    }

    let targetIndex = -1;
    if (typeof identifier === "number") {
      if (identifier >= 0 && identifier < storage.accounts.length) {
        targetIndex = identifier;
      }
    } else {
      const query = identifier.toLowerCase().trim();
      targetIndex = storage.accounts.findIndex(
        (a, idx) =>
          String(idx) === query ||
          a.email?.toLowerCase() === query ||
          a.email?.toLowerCase().includes(query)
      );
    }

    if (targetIndex === -1) {
      const available = storage.accounts.map((a, idx) => `[${idx}] ${a.email}`).join(", ");
      throw new Error(`Account '${identifier}' not found. Available accounts: ${available}`);
    }

    storage.activeAccountIndex = targetIndex;
    fs.writeFileSync(ACCOUNTS_STORAGE_PATH, JSON.stringify(storage, null, 2), "utf-8");
    memoryToken = storage.accounts[targetIndex];
    this.recordPoolEvent({
      type: "switch",
      message: `Switched active account to ${memoryToken.email || "Account #" + targetIndex}`,
      toAccount: memoryToken.email,
    });
    return memoryToken;
  }

  /**
   * Switch account directly by email
   */
  public switchAccountByEmail(email: string): AccountToken {
    return this.switchAccount(email);
  }

  /**
   * Delete an account from the pool by email
   */
  public deleteAccountByEmail(email: string): boolean {
    if (!fs.existsSync(ACCOUNTS_STORAGE_PATH)) return false;

    const storage = this.readStorage();
    const initialLen = storage.accounts.length;
    storage.accounts = storage.accounts.filter(
      (a) => a.email?.toLowerCase() !== email.toLowerCase()
    );
    if (storage.accounts.length === initialLen) return false;

    if (storage.activeAccountIndex >= storage.accounts.length) {
      storage.activeAccountIndex = Math.max(0, storage.accounts.length - 1);
    }
    fs.writeFileSync(ACCOUNTS_STORAGE_PATH, JSON.stringify(storage, null, 2), "utf-8");
    memoryToken = storage.accounts[storage.activeAccountIndex] || null;

    this.recordPoolEvent({
      type: "info",
      message: `Removed account ${email} from pool`,
    });
    return true;
  }

  /**
   * Check if auto-failover is enabled
   */
  public isAutoFailoverEnabled(): boolean {
    return this.autoFailoverEnabled;
  }

  /**
   * Enable/disable auto-failover
   */
  public setAutoFailoverEnabled(enabled: boolean): void {
    this.autoFailoverEnabled = enabled;
    this.recordPoolEvent({
      type: "info",
      message: `Auto-failover ${enabled ? "enabled" : "disabled"}`,
    });
  }

  /**
   * Record an event in the pool event log
   */
  public recordPoolEvent(event: Omit<PoolEvent, "id" | "timestamp">): void {
    const newEvent: PoolEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    this.poolEvents.unshift(newEvent);
    if (this.poolEvents.length > 50) {
      this.poolEvents.pop();
    }
  }

  /**
   * Get recent pool events
   */
  public getPoolEvents(): PoolEvent[] {
    return [...this.poolEvents];
  }

  /**
   * Select the next available account that is not in cooldown.
   * Updates storage and returns the newly active account.
   */
  public selectNextAvailableAccount(excludeEmail?: string): AccountToken | null {
    if (!fs.existsSync(ACCOUNTS_STORAGE_PATH)) return null;

    let storage: AccountsStorage;
    try {
      storage = JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8"));
    } catch {
      return null;
    }

    if (!storage.accounts || storage.accounts.length <= 1) {
      return null;
    }

    const tracker = QuotaTracker.getInstance();
    const currentIndex = storage.activeAccountIndex || 0;
    const total = storage.accounts.length;

    // Scan through all other accounts
    for (let offset = 1; offset < total; offset++) {
      const candidateIdx = (currentIndex + offset) % total;
      const candidate = storage.accounts[candidateIdx];
      if (!candidate || !candidate.refreshToken) continue;
      if (excludeEmail && candidate.email?.toLowerCase() === excludeEmail.toLowerCase()) continue;

      const isLimited = candidate.email ? tracker.isAccountRateLimited(candidate.email) : false;
      if (!isLimited) {
        storage.activeAccountIndex = candidateIdx;
        try {
          fs.writeFileSync(ACCOUNTS_STORAGE_PATH, JSON.stringify(storage, null, 2), "utf-8");
        } catch {}
        memoryToken = candidate;

        this.recordPoolEvent({
          type: "failover",
          message: `Auto-failover switched from ${excludeEmail || "previous"} to ${candidate.email}`,
          fromAccount: excludeEmail,
          toAccount: candidate.email,
        });

        return candidate;
      }
    }

    return null;
  }

  /**
   * Get complete live pool status for UI and API
   */
  public getPoolStatus(): {
    autoFailoverEnabled: boolean;
    totalAccounts: number;
    activeAccount: PublicAccountSummary | null;
    activeIndex: number;
    readyCount: number;
    coolingDownCount: number;
    accounts: Array<{
      email: string;
      name?: string;
      isActive: boolean;
      status: "active" | "ready" | "cooling_down";
      cooldown: { remainingMs: number; resetMessage: string; resetsAt: string } | null;
      quota: any;
    }>;
    recentEvents: PoolEvent[];
  } {
    const tracker = QuotaTracker.getInstance();
    const { accounts, activeIndex } = this.listAccounts();
    const activeAcc = accounts[activeIndex] || null;

    let readyCount = 0;
    let coolingDownCount = 0;

    const accountList = accounts.map((acc, idx) => {
      const email = acc.email || `Account #${idx + 1}`;
      const isActive = idx === activeIndex;
      const cooldown = tracker.getAccountCooldownRemaining(email);
      const isRateLimited = Boolean(cooldown);

      let status: "active" | "ready" | "cooling_down" = "ready";
      if (isRateLimited) {
        status = "cooling_down";
        coolingDownCount++;
      } else if (isActive) {
        status = "active";
        readyCount++;
      } else {
        status = "ready";
        readyCount++;
      }

      return {
        email,
        name: acc.name,
        isActive,
        status,
        cooldown,
        quota: tracker.getQuotaForAccount(email),
      };
    });

    return {
      autoFailoverEnabled: this.autoFailoverEnabled,
      totalAccounts: accounts.length,
      activeAccount: toPublicAccountSummary(activeAcc),
      activeIndex,
      readyCount,
      coolingDownCount,
      accounts: accountList,
      recentEvents: this.poolEvents.slice(0, 20),
    };
  }

  /**
   * Look an account up by its refresh token, which is stable per account —
   * unlike "the active account", which failover can change at any moment.
   */
  private findAccountByRefreshToken(refreshToken: string): AccountToken | null {
    return this.listAccounts().accounts.find((a) => a.refreshToken === refreshToken) || null;
  }

  /**
   * Refresh Google OAuth Access Token using Refresh Token
   */
  public async refreshAccessToken(refreshToken: string): Promise<AccountToken> {
    // Resolve identity from the account that owns this refresh token, and do it
    // before the network round-trip. Reading module state afterwards would be a
    // race: a 429 failover can swap the active account while the request is in
    // flight, and the refreshed token would then be stamped with the *new*
    // account's email, which saveAccount() matches on — overwriting that
    // account's stored entry with this token.
    const owner = this.findAccountByRefreshToken(refreshToken);

    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Token refresh failed with HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type?: string;
    };

    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000 - 60000; // 1 min buffer
    let email = owner?.email;
    let name = owner?.name;

    if (!email) {
      try {
        const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        if (userRes.ok) {
          const uData = (await userRes.json()) as any;
          email = uData.email || email;
          name = uData.name || name;
        }
      } catch {}
    }

    const updated: AccountToken = {
      name,
      email,
      accessToken: data.access_token,
      refreshToken: refreshToken,
      expiresAt: expiresAt,
      projectId: owner?.projectId || DEFAULT_PROJECT_ID,
    };

    this.saveAccount(updated);
    return updated;
  }

  /**
   * Get valid access token (auto-refreshing if expired)
   */
  public async getValidAccessToken(): Promise<string> {
    const acc = this.loadSavedAccount();
    if (!acc || !acc.refreshToken) {
      throw new Error(
        "No Antigravity Google OAuth account found! Please run `npm run bridge:login` to connect your Google account."
      );
    }

    if (acc.accessToken && acc.expiresAt > Date.now() + 60000) {
      if (!acc.email) {
        try {
          const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${acc.accessToken}` },
          });
          if (userRes.ok) {
            const uData = (await userRes.json()) as any;
            if (uData.email) {
              acc.email = uData.email;
              acc.name = uData.name;
              this.saveAccount(acc);
            }
          }
        } catch {}
      }
      return acc.accessToken;
    }

    const refreshToken = acc.refreshToken;
    const inFlight = this.refreshPromises.get(refreshToken);
    if (inFlight) {
      return inFlight;
    }

    const refresh = (async () => {
      try {
        const refreshed = await this.refreshAccessToken(refreshToken);
        return refreshed.accessToken;
      } finally {
        this.refreshPromises.delete(refreshToken);
      }
    })();

    this.refreshPromises.set(refreshToken, refresh);
    return refresh;
  }

  /** Get a valid token for a non-active account without changing the active account. */
  public async getValidAccessTokenForAccount(account: AccountToken): Promise<string> {
    if (account.accessToken && account.expiresAt > Date.now() + 60_000) {
      return account.accessToken;
    }

    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!response.ok) {
      throw new Error(`Token refresh failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    const updated: AccountToken = {
      ...account,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000,
    };
    this.updateStoredAccount(updated);
    return updated.accessToken;
  }

  private updateStoredAccount(updated: AccountToken) {
    try {
      const storage = this.readStorage();
      const index = storage.accounts.findIndex((account) => account.refreshToken === updated.refreshToken);
      if (index >= 0) {
        storage.accounts[index] = updated;
        fs.writeFileSync(ACCOUNTS_STORAGE_PATH, JSON.stringify(storage, null, 2));
      }
    } catch {
      // Keep quota refresh usable even when account metadata cannot be persisted.
    }
  }

  /**
   * Discover Project ID using loadCodeAssist
   */
  public async discoverProjectId(accessToken: string): Promise<string> {
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            "Client-Metadata": JSON.stringify({
              ideType: "ANTIGRAVITY",
              platform: "PLATFORM_UNSPECIFIED",
              pluginType: "GEMINI",
            }),
          },
          body: JSON.stringify({
            metadata: {
              ideType: "ANTIGRAVITY",
              platform: "PLATFORM_UNSPECIFIED",
              pluginType: "GEMINI",
            },
          }),
        });

        if (!res.ok) continue;
        const data = (await res.json()) as any;
        const proj = data?.cloudaicompanionProject;
        if (typeof proj === "string" && proj) return proj;
        if (proj?.id && typeof proj.id === "string") return proj.id;
      } catch {
        // continue
      }
    }
    return DEFAULT_PROJECT_ID;
  }

  /** Exchange an authorization code for tokens for local bridge clients. */
  public async exchangeAuthorizationCode(code: string): Promise<AccountToken> {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: OAUTH_REDIRECT_URI,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Token exchange failed: ${errText}`);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokenData.access_token) throw new Error("Token exchange returned no access token");

    let email = "";
    let name: string | undefined;
    try {
      const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (userRes.ok) {
        const userData = (await userRes.json()) as { email?: string; name?: string };
        email = userData.email || "";
        name = userData.name;
      }
    } catch {
      // Token exchange remains usable if userinfo is temporarily unavailable.
    }

    const expiresIn = tokenData.expires_in || 3600;
    return {
      name,
      email,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || "",
      expiresAt: Date.now() + expiresIn * 1000 - 60_000,
      projectId: await this.discoverProjectId(tokenData.access_token),
    };
  }

  private activeOAuthServer: http.Server | null = null;
  private activeVerifier: string | null = null;

  /**
   * Start web-based OAuth login flow: generates authUrl and binds callback listener
   */
  public getWebOAuthUrl(): string {
    const { verifier, challenge } = generatePKCE();
    this.activeVerifier = verifier;
    const state = base64URLEncode(Buffer.from(JSON.stringify({ verifier })));

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    if (this.activeOAuthServer) {
      try {
        this.activeOAuthServer.close();
      } catch {}
      this.activeOAuthServer = null;
    }

    try {
      this.activeOAuthServer = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "", `http://localhost:${OAUTH_REDIRECT_PORT}`);
          if (reqUrl.pathname !== "/oauth-callback") {
            res.writeHead(404);
            res.end("Not Found");
            return;
          }

          const code = reqUrl.searchParams.get("code");
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<h1>No code provided</h1>");
            return;
          }

          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: ANTIGRAVITY_CLIENT_ID,
              client_secret: ANTIGRAVITY_CLIENT_SECRET,
              code: code,
              grant_type: "authorization_code",
              redirect_uri: OAUTH_REDIRECT_URI,
              code_verifier: this.activeVerifier || "",
            }).toString(),
          });

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<h1>Token Exchange Failed</h1><pre>${errText}</pre>`);
            return;
          }

          const tokenData = (await tokenRes.json()) as any;
          const refreshToken = tokenData.refresh_token;
          const accessToken = tokenData.access_token;
          const expiresIn = tokenData.expires_in || 3600;

          let email = "";
          try {
            const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (userRes.ok) {
              const uData = (await userRes.json()) as any;
              email = uData.email || "";
            }
          } catch {}

          const projectId = await this.discoverProjectId(accessToken);
          const accountToken: AccountToken = {
            email,
            accessToken,
            refreshToken,
            expiresAt: Date.now() + expiresIn * 1000 - 60000,
            projectId: projectId || DEFAULT_PROJECT_ID,
          };
          this.saveAccount(accountToken);
          this.recordPoolEvent({
            type: "info",
            message: `Added new account ${email} to pool`,
            toAccount: email,
          });

          res.writeHead(302, { Location: "http://localhost:52130/?success=1" });
          res.end();

          if (this.activeOAuthServer) {
            this.activeOAuthServer.close();
            this.activeOAuthServer = null;
          }
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error: ${e.message}</h1>`);
        }
      });

      this.activeOAuthServer.listen(OAUTH_REDIRECT_PORT);
    } catch (e) {
      console.warn("Could not bind OAuth callback port 51121:", e);
    }

    return authUrl.toString();
  }

  /**
   * Interactive Login Flow with local server & browser
   */
  public async loginInteractive(): Promise<AccountToken> {
    const { verifier, challenge } = generatePKCE();
    const state = base64URLEncode(Buffer.from(JSON.stringify({ verifier })));

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    console.log("\n========================================================");
    console.log(" Google Antigravity OAuth Login for ZCode");
    console.log("========================================================");
    console.log("\nOpening browser for Google Authentication...\n");
    console.log(`If browser doesn't open automatically, please open this link:\n${authUrl.toString()}\n`);

    return new Promise((resolve, reject) => {
      let server: http.Server;

      const timer = setTimeout(() => {
        if (server) server.close();
        reject(new Error("Login timed out after 3 minutes."));
      }, 180000);

      server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "", `http://localhost:${OAUTH_REDIRECT_PORT}`);
          if (reqUrl.pathname !== "/oauth-callback") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }

          const code = reqUrl.searchParams.get("code");
          const err = reqUrl.searchParams.get("error");

          if (err || !code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<h1>Login Failed</h1><p>${err || "No code provided"}</p>`);
            clearTimeout(timer);
            server.close();
            reject(new Error(`OAuth failed: ${err || "No code provided"}`));
            return;
          }

          // Exchange code for tokens
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: ANTIGRAVITY_CLIENT_ID,
              client_secret: ANTIGRAVITY_CLIENT_SECRET,
              code: code,
              grant_type: "authorization_code",
              redirect_uri: OAUTH_REDIRECT_URI,
              code_verifier: verifier,
            }).toString(),
          });

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<h1>Token Exchange Failed</h1><pre>${errText}</pre>`);
            clearTimeout(timer);
            server.close();
            reject(new Error(`Token exchange failed: ${errText}`));
            return;
          }

          const tokenData = (await tokenRes.json()) as any;
          const refreshToken = tokenData.refresh_token;
          const accessToken = tokenData.access_token;
          const expiresIn = tokenData.expires_in || 3600;

          // Fetch user info for email
          let email = "";
          try {
            const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (userRes.ok) {
              const uData = (await userRes.json()) as any;
              email = uData.email || "";
            }
          } catch {
            // Ignore
          }

          // Discover project ID
          const projectId = await this.discoverProjectId(accessToken);

          const accountToken: AccountToken = {
            email,
            accessToken,
            refreshToken,
            expiresAt: Date.now() + expiresIn * 1000 - 60000,
            projectId: projectId || DEFAULT_PROJECT_ID,
          };

          this.saveAccount(accountToken);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Authentication Successful</title>
                <style>
                  body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
                  .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
                  h1 { color: #38bdf8; margin-top: 0; }
                  p { color: #94a3b8; font-size: 1rem; }
                  .badge { background: #0369a1; color: white; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; }
                </style>
              </head>
              <body>
                <div class="card">
                  <h1>All set!</h1>
                  <p>Successfully authenticated Google Antigravity account:</p>
                  <p><span class="badge">${email || "Google Account"}</span></p>
                  <p>You can now return to terminal or ZCode.</p>
                </div>
              </body>
            </html>
          `);

          clearTimeout(timer);
          server.close();
          console.log(`\nSuccessfully logged in as: ${email || "Google User"}`);
          console.log(`Project ID: ${accountToken.projectId}`);
          resolve(accountToken);
        } catch (e: any) {
          clearTimeout(timer);
          server.close();
          reject(e);
        }
      });

      server.listen(OAUTH_REDIRECT_PORT, () => {
        // Open browser
        const cmd =
          process.platform === "darwin"
            ? `open "${authUrl.toString()}"`
            : process.platform === "win32"
            ? `start "" "${authUrl.toString()}"`
            : `xdg-open "${authUrl.toString()}"`;

        exec(cmd, () => {});
      });
    });
  }
}
