import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import { abortError } from "../src/core.js";
import {
  DEFAULT_USAGE_SETTINGS,
  type UsageSettings,
  type UsageSettingsRuntime,
  type UsageSettingsState,
} from "../src/settings.js";
import usageExtension from "../src/usage.js";

initTheme("dark", false);

const claudeModel = {
  id: "claude-opus-test",
  name: "Claude Opus",
  provider: "claude-bridge",
  baseUrl: "http://bridge.invalid",
};
const openRouterModel = {
  id: "test",
  name: "Test",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};

function settingsRuntime(patch: Partial<UsageSettings> = {}): UsageSettingsRuntime {
  let state: UsageSettingsState = {
    kind: "loaded",
    path: "/tmp/pi-usage.json",
    settings: { ...DEFAULT_USAGE_SETTINGS, ...patch },
    document: patch,
  };
  return {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async (next, signal) => {
      signal?.throwIfAborted();
      state = { ...state, settings: { ...state.settings, ...next }, document: { ...state.document, ...next } };
      return structuredClone(state);
    },
    updateSelectedTarget: async () => assert.fail("Claude has no billing target picker"),
    flush: async () => undefined,
  };
}

function registry() {
  return {
    getAvailable: () => [claudeModel, openRouterModel],
    getAll: () => [claudeModel, openRouterModel],
    getProviderAuth: async (provider: string) => {
      assert.equal(provider, "openrouter");
      return { auth: { apiKey: "fake-openrouter-key" } };
    },
    getProviderAuthStatus: (provider: string) => ({ configured: provider === "openrouter" }),
    getProviderDisplayName: (provider: string) => (provider === "claude-bridge" ? "Claude" : "OpenRouter"),
  };
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, ctx: unknown, event: unknown = {}) {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

function response(used = 2, now?: number) {
  const resetsAt = now === undefined ? undefined : new Date(now + 150_000).toISOString();
  return new Response(
    JSON.stringify({
      five_hour: { utilization: used, resets_at: resetsAt },
      seven_day: { utilization: 24, resets_at: resetsAt },
      seven_day_opus: { utilization: 100, resets_at: resetsAt },
    }),
  );
}

function stubUsageFetch() {
  globalThis.fetch = async (input) =>
    String(input).includes("api.anthropic.com")
      ? response()
      : new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }));
}

test("Claude current usage displays the active model cap without requesting Pi auth", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  stubUsageFetch();
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settingsRuntime(), claudeCredentialReader: async () => "fake-login" });
  let title = "";
  const { ctx, statuses } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: claudeModel,
    modelRegistry: registry(),
    select: async (text: string) => {
      title = text;
      return "Close";
    },
  });
  const command = mock.commands.get("usage");
  assert.ok(command);
  await command.handler("", ctx);
  assert.match(title, /Claude Usage · Current/);
  assert.match(title, /Weekly Opus:.*0% left/);
  assert.equal(statuses.get("usage"), "claude 98% 5h 76% wk 0% opus wk");
});

for (const login of ["missing", "expired", "valid"] as const) {
  test(`Claude configured-provider picker verifies the ${login} login`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.onTestFinished(() => {
      globalThis.fetch = originalFetch;
    });
    stubUsageFetch();
    const mock = createMockPi();
    usageExtension(mock.pi, {
      settingsRuntime: settingsRuntime(),
      claudeCredentialReader: async () => {
        if (login === "expired") throw new Error("Claude Code login has expired. Run `claude` once to refresh it.");
        return login === "valid" ? "fake-login" : undefined;
      },
    });
    const choices =
      login === "valid"
        ? ["View another configured provider…", "Claude", "Close"]
        : ["View another configured provider…", "Close"];
    const screens: Array<{ title: string; options: string[] }> = [];
    const { ctx, notifications, statuses } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model: openRouterModel,
      modelRegistry: registry(),
      select: async (title: string, options: string[]) => {
        screens.push({ title, options });
        return choices.shift();
      },
    });
    await mock.commands.get("usage")?.handler("", ctx);
    const picker = screens.find((screen) => screen.title.includes("Select a configured provider"));
    if (login === "valid") {
      assert.ok(picker?.options.includes("Claude"));
      assert.ok(screens.some((screen) => screen.title.includes("Claude Usage · Configured")));
    } else {
      assert.equal(picker, undefined);
      assert.match(notifications[0]?.message ?? "", /No other supported provider has configured runtime auth/);
      assert.ok(screens.every((screen) => !screen.title.includes("Claude Usage · Configured")));
    }
    assert.equal(statuses.get("usage"), "openrouter $75.00 left");
  });
}

test("all-provider queries exclude an unavailable Claude login and include it after login", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  stubUsageFetch();
  let token: string | undefined;
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settingsRuntime(), claudeCredentialReader: async () => token });
  const titles: string[] = [];
  let actions = ["View all configured providers…", "Close"];
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: openRouterModel,
    modelRegistry: registry(),
    select: async (title: string) => {
      titles.push(title);
      return actions.shift();
    },
  });
  await mock.commands.get("usage")?.handler("", ctx);
  assert.ok(titles.every((title) => !title.includes("Claude")));
  token = "fake-login";
  actions = ["View all configured providers…", "Close"];
  titles.length = 0;
  await mock.commands.get("usage")?.handler("", ctx);
  assert.ok(titles.some((title) => title.includes("Claude Usage · Configured")));
});

for (const cancellation of ["shutdown", "replacement", "model change"] as const) {
  test(`Claude credential work is cancelled by session ${cancellation}`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.onTestFinished(() => {
      globalThis.fetch = originalFetch;
    });
    stubUsageFetch();
    const mock = createMockPi();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCancelled: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    let reading = false;
    usageExtension(mock.pi, {
      settingsRuntime: settingsRuntime(),
      claudeCredentialReader: async (_now, signal) =>
        new Promise<string>((_resolve, reject) => {
          reading = true;
          signal?.addEventListener(
            "abort",
            () => {
              reading = false;
              markCancelled();
              reject(abortError());
            },
            { once: true },
          );
          markStarted();
        }),
    });
    const { ctx, statuses } = createMockContext({ model: claudeModel, modelRegistry: registry() });
    await emit(mock, "session_start", ctx);
    await started;
    if (cancellation === "shutdown") await emit(mock, "session_shutdown", ctx);
    else {
      Object.assign(ctx, { model: cancellation === "replacement" ? undefined : openRouterModel });
      await emit(mock, cancellation === "replacement" ? "session_start" : "model_select", ctx, {
        model: openRouterModel,
      });
    }
    await cancelled;
    assert.equal(reading, false);
    await emit(mock, "session_shutdown", ctx);
    assert.equal(statuses.get("usage"), undefined);
  });
}

for (const discovery of ["another", "all"] as const) {
  for (const replacement of ["menu", "model", "turn", "branch"] as const) {
    test(`pending Claude ${discovery}-provider discovery is cancelled on ${replacement} replacement`, async (t) => {
      const originalFetch = globalThis.fetch;
      const requests: string[] = [];
      globalThis.fetch = async (input) => {
        requests.push(String(input));
        return response();
      };
      t.onTestFinished(() => {
        globalThis.fetch = originalFetch;
      });
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let readerCalls = 0;
      let signal: AbortSignal | undefined;
      const mock = createMockPi();
      usageExtension(mock.pi, {
        settingsRuntime: settingsRuntime(),
        claudeCredentialReader: async (_now, ownedSignal) => {
          readerCalls += 1;
          if (readerCalls > 1) return undefined;
          signal = ownedSignal;
          return new Promise<string>((_resolve, reject) => {
            ownedSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
            markStarted();
          });
        },
      });
      const unsupportedModel = { ...openRouterModel, provider: "unsupported" };
      const actions = [
        discovery === "another" ? "View another configured provider…" : "View all configured providers…",
      ];
      const { ctx } = createMockContext({
        mode: "rpc",
        hasUI: true,
        model: unsupportedModel,
        modelRegistry: registry(),
        select: async () => actions.shift() ?? "Close",
      });
      await emit(mock, "session_start", ctx);
      const command = mock.commands.get("usage");
      assert.ok(command);
      const pending = command.handler("", ctx);
      try {
        await started;
        if (replacement === "menu") await command.handler("", ctx);
        else if (replacement === "model") {
          Object.assign(ctx, { model: claudeModel });
          await emit(mock, "model_select", ctx, { model: claudeModel });
        } else {
          await emit(mock, replacement === "turn" ? "turn_start" : "session_tree", ctx);
        }
        assert.equal(signal?.aborted, true);
        await pending;
        assert.deepEqual(requests, []);
      } finally {
        await emit(mock, "session_shutdown", ctx);
      }
    });
  }
}

for (const cancellation of ["hard cancel", "configured cancel", "disposal"] as const) {
  test(`Claude TUI auth loading releases credential work on ${cancellation}`, async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let cancelled = false;
    const mock = createMockPi();
    usageExtension(mock.pi, {
      settingsRuntime: settingsRuntime(),
      claudeCredentialReader: async (_now, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(abortError());
            },
            { once: true },
          );
          markStarted();
        }),
    });
    let frame: string[] = [];
    const { ctx, statuses } = createMockContext({
      hasUI: true,
      mode: "tui",
      model: claudeModel,
      modelRegistry: registry(),
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 80, {
          matches: (data, key) => key === "tui.select.cancel" && data === "q",
          getKeys: (key) => (key === "tui.select.cancel" ? ["q"] : []),
        });
        frame = harness.render();
        try {
          await started;
          if (cancellation === "disposal") return undefined;
          harness.handleInput(cancellation === "hard cancel" ? "\u0003" : "q");
          return await harness.resultPromise;
        } finally {
          harness.dispose();
        }
      },
    });
    await mock.commands.get("usage")?.handler("", ctx);
    assert.equal(cancelled, true);
    assert.equal(statuses.get("usage"), undefined);
    assert.match(frame.join("\n"), /Checking current usage/);
  });
}

test("a Claude auth deadline cancels its owned reader rather than only rejecting the waiter", async () => {
  vi.useFakeTimers();
  const mock = createMockPi();
  let cancelled = 0;
  usageExtension(mock.pi, {
    settingsRuntime: settingsRuntime(),
    claudeCredentialReader: async (_now, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancelled += 1;
            reject(abortError());
          },
          { once: true },
        );
      }),
  });
  const { ctx, statuses } = createMockContext({ model: claudeModel, modelRegistry: registry() });
  await emit(mock, "session_start", ctx);
  await vi.advanceTimersByTimeAsync(15_000);
  assert.equal(cancelled, 1);
  assert.match(statuses.get("usage") ?? "", /usage err: Timed out/);
  await emit(mock, "session_shutdown", ctx);
});

for (const rotation of ["before request", "after response"] as const) {
  test(`Claude token rotation ${rotation} retries with the new account and never publishes stale usage`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.onTestFinished(() => {
      globalThis.fetch = originalFetch;
    });
    let token = "fake-account-a";
    let reads = 0;
    const requests: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      requests.push(authorization);
      if (authorization === "Bearer fake-account-a") {
        token = "fake-account-b";
        return response(1);
      }
      return response(60);
    };
    const mock = createMockPi();
    usageExtension(mock.pi, {
      settingsRuntime: settingsRuntime(),
      claudeCredentialReader: async () => {
        reads += 1;
        if (rotation === "before request" && reads === 2) token = "fake-account-b";
        return token;
      },
    });
    const titles: string[] = [];
    const { ctx, statuses } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model: claudeModel,
      modelRegistry: registry(),
      select: async (title: string) => {
        titles.push(title);
        return "Close";
      },
    });
    const command = mock.commands.get("usage");
    assert.ok(command);
    await command.handler("", ctx);
    assert.equal(statuses.get("usage"), "claude 40% 5h 76% wk 0% opus wk");
    assert.ok(titles.every((title) => !title.includes("99% left")));
    assert.deepEqual(
      requests,
      rotation === "before request" ? ["Bearer fake-account-b"] : ["Bearer fake-account-a", "Bearer fake-account-b"],
    );
    const beforeCacheQuery = requests.length;
    await command.handler("", ctx);
    assert.equal(requests.length, beforeCacheQuery);
    assert.equal(statuses.get("usage"), "claude 40% 5h 76% wk 0% opus wk");
  });
}

test("Claude preferences repaint reset countdowns without HTTP reads and release timers on replacement", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  vi.useFakeTimers();
  const now = Date.parse("2026-09-30T00:00:00Z");
  vi.setSystemTime(now);
  let fetches = 0;
  let authReads = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return response(2, now);
  };
  const mock = createMockPi();
  usageExtension(mock.pi, {
    settingsRuntime: settingsRuntime({ claudeStatusResetCountdown: true, claudeStatusPercentage: "used" }),
    claudeCredentialReader: async () => {
      authReads += 1;
      return "fake-login";
    },
  });
  const { ctx, statuses } = createMockContext({ model: claudeModel, modelRegistry: registry() });
  await emit(mock, "session_start", ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.match(statuses.get("usage") ?? "", /^claude 2% ↻ 3m/);
  assert.match(statuses.get("usage") ?? "", /100%.*opus/);
  const initialAuthReads = authReads;
  await vi.advanceTimersByTimeAsync(60_000);
  assert.match(statuses.get("usage") ?? "", /^claude 2% ↻ 2m/);
  assert.equal(fetches, 1);
  assert.equal(authReads, initialAuthReads);
  Object.assign(ctx, { model: undefined });
  await emit(mock, "session_start", ctx);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  assert.equal(statuses.get("usage"), undefined);
  assert.equal(fetches, 1);
  await emit(mock, "session_shutdown", ctx);
});
