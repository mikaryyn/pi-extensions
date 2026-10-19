import assert from "node:assert/strict";
import { test } from "vitest";
import { formatUsageStatusline } from "../src/format.js";
import type { UsageBucket, UsageModel, UsageReport } from "../src/types.js";

function bucket(
  id: string,
  remaining: number,
  options: { resetsAt?: number; windowMinutes?: number } = {},
): UsageBucket {
  return {
    id,
    label: id,
    remaining,
    unit: "percent",
    ...options,
  };
}

function report(buckets: UsageBucket[]): UsageReport {
  return {
    providerId: "claude-bridge",
    providerName: "Claude",
    capturedAt: 1,
    source: "test",
    semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
    buckets,
    metrics: [],
  };
}

function model(id: string, name = id): UsageModel {
  return { id, name, provider: "claude-bridge" };
}

const allCaps = report([
  bucket("five-hour", 98, { windowMinutes: 300 }),
  bucket("weekly", 76, { windowMinutes: 10_080 }),
  bucket("weekly-opus", 0, { windowMinutes: 10_080 }),
  bucket("weekly-sonnet", 41, { windowMinutes: 10_080 }),
]);

test("Claude statusline defaults to remaining general and matching model caps", () => {
  assert.equal(formatUsageStatusline(allCaps, model("claude-opus-4-6")), "claude 98% 5h 76% wk 0% opus wk");
  assert.equal(formatUsageStatusline(allCaps), "claude 98% 5h 76% wk");
});

test("Claude used percentages complement rounded and clamped remaining values", () => {
  const usage = report([bucket("five-hour", 99.6), bucket("weekly", -12), bucket("weekly-opus", 34.4)]);
  assert.equal(
    formatUsageStatusline(usage, model("claude-opus-4-6"), 1_000_000, false, "used", { percentage: "used" }),
    "claude 0% 5h 100% wk 66% opus wk",
  );
});

test("Claude model family comes from normalized id/name without displaying either string", () => {
  const identityCases: [UsageModel, string][] = [
    [model("claude-opus-4-6", "Claude Opus 4.6"), "0% opus wk"],
    [model("claude-sonnet-4-5", "Claude Sonnet 4.5"), "41% sonnet wk"],
    [model("custom-model", "Claude Sonnet (Latest)"), "41% sonnet wk"],
  ];
  for (const [identity, expected] of identityCases) {
    assert.equal(formatUsageStatusline(allCaps, identity), `claude 98% 5h 76% wk ${expected}`);
  }

  const ambiguous = model("claude-opus-4-6", "Claude Sonnet 4.5");
  assert.equal(formatUsageStatusline(allCaps, ambiguous), "claude 98% 5h 76% wk");
  assert.equal(formatUsageStatusline(allCaps, model("claude-opus-sonnet-preview")), "claude 98% 5h 76% wk");

  const untrusted = model("claude-\u001b[31mopus-4-6\u001b[0m", "\u001b]0;sonnet\u0007Claude Opus");
  const text = formatUsageStatusline(allCaps, untrusted);
  assert.equal(text, "claude 98% 5h 76% wk 0% opus wk");
  assert.ok(!text?.includes("\u001b"));
  assert.equal(
    formatUsageStatusline(allCaps, { ...model("claude-opus"), provider: "openrouter" }),
    "claude 98% 5h 76% wk",
  );
});

test("Claude matching model caps render alone while missing and unknown caps stay hidden", () => {
  const opusOnly = report([bucket("weekly-opus", 0)]);
  assert.equal(formatUsageStatusline(opusOnly, model("claude-3-opus")), "claude 0% opus wk");
  assert.equal(formatUsageStatusline(opusOnly, model("unknown-model")), undefined);
  assert.equal(formatUsageStatusline(report([bucket("weekly-opus", Number.NaN)]), model("claude-opus")), undefined);
  assert.equal(formatUsageStatusline(report([]), model("claude-sonnet")), undefined);
});

test("Claude reset countdowns use per-bucket resets and fall back to the window label", () => {
  const timed = report([
    bucket("five-hour", 25, { resetsAt: 1_060, windowMinutes: 300 }),
    bucket("weekly", 70, { windowMinutes: 10_080 }),
    bucket("weekly-sonnet", 0, { resetsAt: 900, windowMinutes: 10_080 }),
  ]);
  assert.equal(
    formatUsageStatusline(timed, model("claude-sonnet"), 1_000_000, true, "remaining", {
      showResetCountdown: true,
    }),
    "claude 25% ↻ 1m 70% wk 0% sonnet ↻ 0m",
  );
});
