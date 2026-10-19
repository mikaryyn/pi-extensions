import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { abortError, sanitizeDisplayText } from "../core.js";
import type { ClaudeOAuthUsagePayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

export const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge";
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_ACCOUNT_FALLBACK = "claude-code-user";
const EXPIRED_MESSAGE = "Claude Code login has expired. Run `claude` once to refresh it.";
const INVALID_TOKEN_MESSAGE = "Claude Code OAuth token is invalid.";
const KEYCHAIN_READ_ERROR = "Unable to read Claude Code credentials from the macOS Keychain.";
const KEYCHAIN_ACCESS_ERROR = "Claude Code Keychain access was denied or is unavailable.";
const KEYCHAIN_TIMEOUT_ERROR = "Timed out reading Claude Code credentials from the macOS Keychain.";
const KEYCHAIN_INVALID_ERROR = "Claude Code Keychain credentials are invalid.";
const CREDENTIALS_FILE_READ_ERROR = "Unable to read Claude Code credentials file.";
const UNSUPPORTED_OAUTH_ENDPOINT_ERROR = "Claude Code custom OAuth endpoints are not supported for usage reporting.";
const UNSUPPORTED_AUTH_ERROR =
  "Claude usage cannot match this Claude Code authentication override to a subscription login.";
const ALTERNATE_AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
] as const;
const ALTERNATE_PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
] as const;

const WINDOWS = [
  { key: "five_hour", id: "five-hour", label: "Session", windowMinutes: 300 },
  { key: "seven_day", id: "weekly", label: "Weekly", windowMinutes: 10_080 },
  { key: "seven_day_opus", id: "weekly-opus", label: "Weekly Opus", windowMinutes: 10_080 },
  { key: "seven_day_sonnet", id: "weekly-sonnet", label: "Weekly Sonnet", windowMinutes: 10_080 },
] as const;

export function normalizeClaudeOAuthUsagePayload(payload: ClaudeOAuthUsagePayload, capturedAt: number): UsageReport {
  const buckets: UsageBucket[] = [];
  for (const window of WINDOWS) {
    const value = asObject(payload[window.key]);
    const used = asFiniteNumber(value?.utilization);
    if (!value || used === undefined) continue;
    const resetsAt = resetTimestamp(value.resets_at);
    buckets.push({
      id: window.id,
      label: window.label,
      used,
      remaining: 100 - Math.min(100, Math.max(0, used)),
      limit: 100,
      unit: "percent",
      windowMinutes: window.windowMinutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }

  const metrics: UsageMetric[] = [];
  const extra = asObject(payload.extra_usage);
  const credits = asFiniteNumber(extra?.used_credits);
  const currency = asString(extra?.currency);
  if (extra?.is_enabled === true && credits !== undefined && credits >= 0 && currency) {
    const decimals = asFiniteNumber(extra.decimal_places);
    const scale = decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? decimals : 2;
    metrics.push({
      id: "extra-usage",
      label: "Extra usage spent",
      value: Number((credits / 10 ** scale).toFixed(scale)),
      unit: "currency",
      currency,
    });
  }

  if (buckets.length === 0 && metrics.length === 0) {
    throw new Error("Claude usage endpoint returned no displayable usage data.");
  }

  return {
    providerId: CLAUDE_BRIDGE_PROVIDER_ID,
    providerName: "Claude",
    capturedAt,
    source: "claude-oauth-usage",
    semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
    buckets,
    metrics,
  };
}

/** Pure parser for Claude Code's stored credential JSON; never echoes the token in errors. */
export function parseClaudeCodeAccessToken(raw: string, now: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const oauth = asObject(asObject(parsed)?.claudeAiOauth);
  const token = oauth?.accessToken;
  if (typeof token !== "string" || invalidAccessToken(token)) return undefined;
  const expiresAt = asFiniteNumber(oauth?.expiresAt);
  if (expiresAt !== undefined && expiresAt <= now) throw new Error(EXPIRED_MESSAGE);
  return token;
}

/** Reads Claude Code's existing login without refreshing or writing it back. */
export async function readClaudeCodeAccessToken(
  now: number = Date.now(),
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);

  // An environment token can also belong to a custom OAuth origin; never forward it to production.
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) throw new Error(UNSUPPORTED_OAUTH_ENDPOINT_ERROR);
  assertSupportedAuthEnvironment();
  const environmentToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (environmentToken !== undefined && environmentToken.length > 0) {
    if (invalidAccessToken(environmentToken)) throw new Error(INVALID_TOKEN_MESSAGE);
    return environmentToken;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) throw new Error(UNSUPPORTED_AUTH_ERROR);
  const storage = selectedCredentialStorage();
  if (process.platform === "darwin") {
    const stored = await readKeychain(storage.service, keychainAccount(), signal);
    throwIfAborted(signal);
    if (stored !== undefined) {
      const token = parseClaudeCodeAccessToken(stored, now);
      if (token) return token;
      throw new Error(KEYCHAIN_INVALID_ERROR);
    }
  }

  const credentialsPath = join(storage.directory, ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(credentialsPath, { encoding: "utf8", signal });
  } catch (error) {
    throwIfAborted(signal);
    if (isErrorCode(error, "ENOENT")) return undefined;
    if (isAbortError(error)) throw abortError();
    throw new Error(CREDENTIALS_FILE_READ_ERROR);
  }
  throwIfAborted(signal);
  return parseClaudeCodeAccessToken(raw, now);
}

interface CredentialStorage {
  directory: string;
  service: string;
}

function assertSupportedAuthEnvironment(): void {
  if (
    ALTERNATE_AUTH_VARIABLES.some((key) => Boolean(process.env[key])) ||
    ALTERNATE_PROVIDER_FLAGS.some((key) => /^(1|true|yes|on)$/iu.test(process.env[key]?.trim() ?? ""))
  ) {
    throw new Error(UNSUPPORTED_AUTH_ERROR);
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    try {
      if (new URL(process.env.ANTHROPIC_BASE_URL).origin === new URL(CLAUDE_OAUTH_USAGE_URL).origin) return;
    } catch {
      // Never include the overridden URL, which may contain credentials, in an error.
    }
    throw new Error(UNSUPPORTED_OAUTH_ENDPOINT_ERROR);
  }
}

function selectedCredentialStorage(): CredentialStorage {
  const secureStorageDirectory = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureStorageDirectory !== undefined) {
    if (!secureStorageDirectory) return defaultCredentialStorage();
    const directory = secureStorageDirectory.normalize("NFC");
    return { directory, service: customKeychainService(directory) };
  }

  const configDirectory = process.env.CLAUDE_CONFIG_DIR;
  if (configDirectory === undefined) return defaultCredentialStorage();
  const directory = configDirectory.normalize("NFC");
  return {
    directory,
    service: configDirectory ? customKeychainService(directory) : KEYCHAIN_SERVICE,
  };
}

function defaultCredentialStorage(): CredentialStorage {
  return { directory: join(homedir(), ".claude").normalize("NFC"), service: KEYCHAIN_SERVICE };
}

function customKeychainService(directory: string): string {
  // Claude Code's custom-directory suffix is observed CLI behavior, not a public storage schema.
  const hash = createHash("sha256").update(directory).digest("hex").slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

function keychainAccount(): string {
  let candidate = process.env.USER;
  if (!candidate) {
    try {
      candidate = userInfo().username;
    } catch {
      return KEYCHAIN_ACCOUNT_FALLBACK;
    }
  }
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : KEYCHAIN_ACCOUNT_FALLBACK;
}

function readKeychain(service: string, account: string, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    try {
      execFile(
        "security",
        ["find-generic-password", "-a", account, "-s", service, "-w"],
        { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024, signal },
        (error, stdout) => {
          if (signal?.aborted || isAbortError(error)) {
            reject(abortError());
            return;
          }
          if (error) {
            if (isMissingKeychainItem(error)) {
              resolve(undefined);
              return;
            }
            if (isKeychainTimeout(error)) {
              reject(new Error(KEYCHAIN_TIMEOUT_ERROR));
              return;
            }
            if (isKeychainAccessError(error)) {
              reject(new Error(KEYCHAIN_ACCESS_ERROR));
              return;
            }
            reject(new Error(KEYCHAIN_READ_ERROR));
            return;
          }
          resolve(stdout.trim());
        },
      );
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) reject(abortError());
      else if (isMissingKeychainItem(error)) resolve(undefined);
      else reject(new Error(KEYCHAIN_READ_ERROR));
    }
  });
}

function isMissingKeychainItem(error: unknown): boolean {
  return isErrorCode(error, "ENOENT") || isErrorCode(error, "44");
}

function isKeychainTimeout(error: unknown): boolean {
  return isErrorCode(error, "ETIMEDOUT") || Boolean(asObject(error)?.killed);
}

function isKeychainAccessError(error: unknown): boolean {
  const detail = asObject(error);
  const code = typeof detail?.code === "string" ? detail.code : "";
  const message = typeof detail?.message === "string" ? detail.message : "";
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ELOCKED" ||
    /denied|locked|interaction not allowed|user interaction/i.test(`${code} ${message}`)
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  const value = asObject(error)?.code;
  return value === code || value === Number(code);
}

function invalidAccessToken(value: string): boolean {
  return !value || /[^\x21-\x7e]/u.test(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return asObject(error)?.name === "AbortError";
}

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : Math.floor(milliseconds / 1000);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, 16) || undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
