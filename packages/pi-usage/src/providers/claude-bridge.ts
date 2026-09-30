import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeDisplayText } from "../core.js";
import type { ClaudeOAuthUsagePayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

export const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge";
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;
const EXPIRED_MESSAGE = "Claude Code login has expired. Run `claude` once to refresh it.";

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
  if (typeof token !== "string" || !token) return undefined;
  const expiresAt = asFiniteNumber(oauth?.expiresAt);
  if (expiresAt !== undefined && expiresAt <= now) throw new Error(EXPIRED_MESSAGE);
  return token;
}

/** Reads Claude Code's existing login without refreshing or writing it back. */
export async function readClaudeCodeAccessToken(now: number = Date.now()): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const stored = await readKeychain();
    const token = stored === undefined ? undefined : parseClaudeCodeAccessToken(stored, now);
    if (token) return token;
  }
  const directory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    return parseClaudeCodeAccessToken(await readFile(join(directory, ".credentials.json"), "utf8"), now);
  } catch (error) {
    if (error instanceof Error && error.message === EXPIRED_MESSAGE) throw error;
    return undefined;
  }
}

function readKeychain(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    );
  });
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
