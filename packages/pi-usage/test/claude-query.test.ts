import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { abortError } from "../src/core.js";
import { CLAUDE_BRIDGE_ADAPTER, providerIsConfigured, queryProviderUsage, resolveUsageAuth } from "../src/query.js";
import type { ResolvedUsageAuth } from "../src/types.js";

const model = {
  id: "claude-opus-test",
  name: "Claude Opus",
  provider: "claude-bridge",
  baseUrl: "http://bridge.invalid",
};

function context(models = [model]) {
  return createMockContext({
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderAuth: async () => assert.fail("Claude must not resolve Pi-registry credentials"),
    },
  }).ctx;
}

async function auth(token = "fake-claude-secret"): Promise<ResolvedUsageAuth> {
  const resolved = await resolveUsageAuth(context(), CLAUDE_BRIDGE_ADAPTER, new Uint8Array(32), undefined, undefined, {
    claudeCredentialReader: async () => token,
  });
  assert.ok(resolved);
  return resolved;
}

test("Claude auth uses the selected external login, propagates cancellation, and fingerprints token changes", async () => {
  const controller = new AbortController();
  let passedSignal: AbortSignal | undefined;
  const first = await resolveUsageAuth(context(), CLAUDE_BRIDGE_ADAPTER, new Uint8Array(32), undefined, undefined, {
    signal: controller.signal,
    claudeCredentialReader: async (_now, signal) => {
      passedSignal = signal;
      return "fake-first-account";
    },
  });
  assert.ok(first);
  assert.equal(passedSignal, controller.signal);
  assert.deepEqual(first.headers, {
    Authorization: "Bearer fake-first-account",
    "anthropic-beta": "oauth-2025-04-20",
  });
  assert.deepEqual(first.secrets, ["fake-first-account", "Bearer fake-first-account"]);
  assert.equal(first.model, model);
  const second = await auth("fake-second-account");
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.ok(!first.fingerprint.includes("fake-first-account"));
});

test("Claude auth does not read a login without a bridge model or after pre-abort", async () => {
  let reads = 0;
  const claudeCredentialReader = async () => {
    reads += 1;
    return "fake";
  };
  assert.equal(
    await resolveUsageAuth(context([]), CLAUDE_BRIDGE_ADAPTER, undefined, undefined, undefined, {
      claudeCredentialReader,
    }),
    undefined,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveUsageAuth(context(), CLAUDE_BRIDGE_ADAPTER, undefined, undefined, undefined, {
      signal: controller.signal,
      claudeCredentialReader,
    }),
    { name: "AbortError" },
  );
  assert.equal(reads, 0);
});

test("Claude auth rejects an aborted credential continuation even if the reader returns a token", async () => {
  const controller = new AbortController();
  await assert.rejects(
    resolveUsageAuth(context(), CLAUDE_BRIDGE_ADAPTER, undefined, undefined, undefined, {
      signal: controller.signal,
      claudeCredentialReader: async () => {
        controller.abort();
        return "fake-stale-token";
      },
    }),
    { name: "AbortError" },
  );
});

test("Claude configuration requires a verified login rather than model or Pi auth presence", () => {
  assert.equal(providerIsConfigured(context(), "claude-bridge"), false);
  assert.equal(providerIsConfigured(context(), "claude-bridge", new Set(["claude-bridge"])), true);
  assert.equal(providerIsConfigured(context([]), "claude-bridge", new Set(["claude-bridge"])), false);
});

test("Claude usage sends only the resolved token to the fixed URL and guards both request boundaries", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const resolved = await auth();
  let fetches = 0;
  let guards = 0;
  let request: { url: string; init: RequestInit | undefined } | undefined;
  globalThis.fetch = async (input, init) => {
    fetches += 1;
    request = { url: String(input), init };
    return new Response(JSON.stringify({ five_hour: { utilization: 25 } }), { status: 200 });
  };
  await assert.rejects(
    queryProviderUsage(CLAUDE_BRIDGE_ADAPTER, resolved, new AbortController().signal, 1000),
    /request-boundary revalidation/,
  );
  assert.equal(fetches, 0);
  const report = await queryProviderUsage(
    CLAUDE_BRIDGE_ADAPTER,
    resolved,
    new AbortController().signal,
    1000,
    async () => {
      guards += 1;
    },
  );
  assert.equal(guards, 2);
  assert.equal(fetches, 1);
  assert.equal(request?.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(request?.init?.redirect, "error");
  assert.deepEqual(request?.init?.headers, { ...resolved.headers, "User-Agent": "pi-usage" });
  assert.equal(report.buckets[0]?.remaining, 75);
});

test("Claude usage rejects a changed request boundary without sending the token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => assert.fail("a failed guard must prevent the request");
  await assert.rejects(
    queryProviderUsage(CLAUDE_BRIDGE_ADAPTER, await auth(), new AbortController().signal, 1000, async () => {
      throw abortError();
    }),
    { name: "AbortError" },
  );
});

test("Claude usage redacts response errors and refuses redirected and malformed responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const resolved = await auth();
  const query = () =>
    queryProviderUsage(CLAUDE_BRIDGE_ADAPTER, resolved, new AbortController().signal, 1000, async () => undefined);
  globalThis.fetch = async () => new Response("denied fake-claude-secret", { status: 403 });
  await assert.rejects(query(), (error: Error) => {
    assert.match(error.message, /403.*<redacted>/);
    assert.ok(!error.message.includes("fake-claude-secret"));
    return true;
  });
  globalThis.fetch = async () => {
    const response = new Response("{}");
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  await assert.rejects(query(), /refused a redirected response/);
  for (const response of ["[]", "null", "{invalid"]) {
    globalThis.fetch = async () => new Response(response);
    await assert.rejects(query(), /not an object|invalid JSON/);
  }
});

test("Claude usage HTTP cancellation and timeout settle without exposing a token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  vi.useFakeTimers();
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  const resolved = await auth();
  const controller = new AbortController();
  const cancelled = queryProviderUsage(CLAUDE_BRIDGE_ADAPTER, resolved, controller.signal, 1000, async () => undefined);
  const cancelledAssertion = assert.rejects(cancelled, { name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await cancelledAssertion;
  const timedOut = queryProviderUsage(
    CLAUDE_BRIDGE_ADAPTER,
    resolved,
    new AbortController().signal,
    1000,
    async () => undefined,
  );
  const timeoutAssertion = assert.rejects(timedOut, /Timed out after 1s/);
  await vi.advanceTimersByTimeAsync(1000);
  await timeoutAssertion;
});
