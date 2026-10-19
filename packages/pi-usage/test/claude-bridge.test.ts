import assert from "node:assert/strict";
import { test } from "vitest";
import {
  adapterForProvider,
  formatUsageReport,
  formatUsageStatusline,
  normalizeClaudeOAuthUsagePayload,
  parseClaudeCodeAccessToken,
} from "../src/index.js";

const payload = {
  five_hour: { utilization: 2.0, resets_at: "2026-09-30T15:09:59.79+00:00" },
  seven_day: { utilization: 24, resets_at: "2026-10-05T10:00:00+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: true, used_credits: 74.0, currency: "EUR", decimal_places: 2, monthly_limit: null },
};

test("Claude OAuth usage normalizes session, weekly, and extra usage", () => {
  const report = normalizeClaudeOAuthUsagePayload(payload, 1000);

  assert.equal(report.providerId, "claude-bridge");
  assert.deepEqual(report.semantics, { kind: "consumer-subscription", label: "Claude subscription limits" });
  assert.equal(report.buckets.length, 2);
  assert.deepEqual(report.buckets[0], {
    id: "five-hour",
    label: "Session",
    used: 2,
    remaining: 98,
    limit: 100,
    unit: "percent",
    windowMinutes: 300,
    resetsAt: Math.floor(Date.parse("2026-09-30T15:09:59.79+00:00") / 1000),
  });
  assert.equal(report.buckets[1]?.id, "weekly");
  assert.deepEqual(report.metrics, [
    { id: "extra-usage", label: "Extra usage spent", value: 0.74, unit: "currency", currency: "EUR" },
  ]);
});

test("Claude OAuth usage includes model-specific weekly buckets when present", () => {
  const report = normalizeClaudeOAuthUsagePayload(
    { ...payload, seven_day_opus: { utilization: 120 }, seven_day_sonnet: { utilization: 5 }, extra_usage: null },
    1,
  );
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five-hour", "weekly", "weekly-opus", "weekly-sonnet"],
  );
  assert.equal(report.buckets[2]?.remaining, 0);
  assert.equal(report.buckets[2]?.resetsAt, undefined);
  assert.deepEqual(report.metrics, []);
});

test("Claude OAuth usage rejects empty or malformed payloads", () => {
  assert.throws(() => normalizeClaudeOAuthUsagePayload({}, 1), /no displayable usage/);
  assert.throws(
    () => normalizeClaudeOAuthUsagePayload({ five_hour: "x", extra_usage: { is_enabled: false } }, 1),
    /no displayable usage/,
  );
});

test("Claude report renders bars and currency", () => {
  const text = formatUsageReport(normalizeClaudeOAuthUsagePayload(payload, 1000), "current");
  assert.match(text, /^Claude Usage · Current/);
  assert.match(text, /Session:\s+\[.*\] 98% left/);
  assert.match(text, /Weekly:\s+\[.*\] 76% left/);
  assert.match(text, /Extra usage spent:\s+EUR 0.74/);
});

test("Claude bridge adapter is registered and publishes a statusline", () => {
  const adapter = adapterForProvider("claude-bridge");
  assert.ok(adapter);
  assert.equal(adapter.id, "claude-bridge");
  assert.equal(adapter.displayName, "Claude");
  assert.notEqual(adapter.publishesStatusline, false);
});

test("Claude statusline shows remaining session and weekly percentages", () => {
  const report = normalizeClaudeOAuthUsagePayload({ ...payload, seven_day_opus: { utilization: 50 } }, 1000);
  assert.equal(formatUsageStatusline(report), "claude 98% 5h 76% wk");
  assert.equal(
    formatUsageStatusline(normalizeClaudeOAuthUsagePayload({ extra_usage: payload.extra_usage }, 1)),
    undefined,
  );
});

test("Claude Code credential parsing handles valid, expired, missing, and malformed input", () => {
  const credentials = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt } });
  assert.equal(parseClaudeCodeAccessToken(credentials(2000), 1000), "tok");
  assert.throws(
    () => parseClaudeCodeAccessToken(credentials(1000), 1000),
    (error: Error) => {
      assert.match(error.message, /has expired/);
      assert.ok(!error.message.includes("tok"));
      return true;
    },
  );
  assert.equal(parseClaudeCodeAccessToken("{}", 1000), undefined);
  assert.equal(parseClaudeCodeAccessToken("not json", 1000), undefined);
});
