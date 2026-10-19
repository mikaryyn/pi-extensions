import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFile: vi.fn(),
  homedir: vi.fn(),
  userInfo: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("node:os", () => ({ homedir: mocks.homedir, userInfo: mocks.userInfo }));

import { parseClaudeCodeAccessToken, readClaudeCodeAccessToken } from "../src/providers/claude-bridge.js";

const ENV_KEYS = [
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "USER",
] as const;
const originalEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function credentials(token: string, expiresAt?: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt !== undefined ? { expiresAt } : {}) } });
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function setKeychainResult(stdout: string): void {
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, "");
    return undefined;
  });
}

function setKeychainError(code: string | number, detail = "keychain failed"): void {
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
    callback(Object.assign(new Error(detail), { code }), "", detail);
    return undefined;
  });
}

function setFileResult(content: string): void {
  mocks.readFile.mockResolvedValue(content);
}

function setFileError(code: string, detail = "file failed"): void {
  mocks.readFile.mockRejectedValue(Object.assign(new Error(detail), { code }));
}

function customService(directory: string): string {
  const hash = createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function keychainArguments(): [unknown, unknown[]] {
  const call = mocks.execFile.mock.calls[0];
  assert.ok(call && Array.isArray(call[1]));
  return [call[0], call[1]];
}

function calledFilePath(): string | undefined {
  return mocks.readFile.mock.calls[0]?.[0] as string | undefined;
}

function assertSecretSafe(error: unknown, secret: string): void {
  assert.ok(error instanceof Error);
  assert.ok(!error.message.includes(secret));
  assert.ok(!error.message.includes("keychain failed"));
  assert.ok(!error.message.includes("file failed"));
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  setPlatform("darwin");
  mocks.homedir.mockReturnValue("/home/mock-user");
  mocks.userInfo.mockReturnValue({ username: "os-user" });
  process.env.USER = "env-user";
  setKeychainResult(credentials("keychain-token"));
  setFileError("ENOENT");
});

afterAll(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

test("uses the default macOS service, account, and matching credentials file", async () => {
  setKeychainError(44);
  setFileResult(credentials("file-token"));

  assert.equal(await readClaudeCodeAccessToken(1000), "file-token");
  assert.equal(keychainArguments()[0], "security");
  assert.deepEqual(keychainArguments()[1], [
    "find-generic-password",
    "-a",
    "env-user",
    "-s",
    "Claude Code-credentials",
    "-w",
  ]);
  assert.equal(calledFilePath(), join("/home/mock-user", ".claude", ".credentials.json"));
});

test.each([
  {
    label: "default directory",
    configured: undefined,
    directory: "/home/mock-user/.claude",
    service: "Claude Code-credentials",
  },
  { label: "explicit empty directory", configured: "", directory: "", service: "Claude Code-credentials" },
  { label: "relative path", configured: "relative/./store", directory: "relative/./store", service: undefined },
  { label: "trailing slash", configured: "/tmp/claude-store/", directory: "/tmp/claude-store/", service: undefined },
  { label: "NFC-normalized path", configured: "/tmp/cafe\u0301", directory: "/tmp/café", service: undefined },
])(
  "selects the $label store without resolving or trimming its configured path",
  async ({ configured, directory, service }) => {
    if (configured !== undefined) process.env.CLAUDE_CONFIG_DIR = configured;
    setKeychainError(44);
    setFileResult(credentials("file-token"));

    assert.equal(await readClaudeCodeAccessToken(), "file-token");
    const selectedService = service ?? customService(directory);
    assert.equal(keychainArguments()[1]?.[4], selectedService);
    assert.equal(calledFilePath(), join(directory, ".credentials.json"));
  },
);

test.each([
  { secure: "", directory: "/home/mock-user/.claude", service: "Claude Code-credentials" },
  { secure: "../secure/claude", directory: "../secure/claude", service: customService("../secure/claude") },
])(
  "lets CLAUDE_SECURESTORAGE_CONFIG_DIR override CLAUDE_CONFIG_DIR ($secure)",
  async ({ secure, directory, service }) => {
    process.env.CLAUDE_CONFIG_DIR = "/ignored/config";
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
    setKeychainError(44);
    setFileResult(credentials("file-token"));

    assert.equal(await readClaudeCodeAccessToken(), "file-token");
    assert.equal(keychainArguments()[1]?.[4], service);
    assert.equal(calledFilePath(), join(directory, ".credentials.json"));
  },
);

test.each([
  { label: "valid USER", user: "some.user-1", osUser: "ignored", expected: "some.user-1" },
  { label: "USER fallback to os user", user: undefined, osUser: "os.user-1", expected: "os.user-1" },
  { label: "invalid USER", user: "bad/user", osUser: "ignored", expected: "claude-code-user" },
  { label: "invalid os username", user: undefined, osUser: "bad/user", expected: "claude-code-user" },
  { label: "os username lookup error", user: undefined, osUser: "throws", expected: "claude-code-user" },
])("uses the safe Keychain account for $label", async ({ user, osUser, expected }) => {
  if (user !== undefined) process.env.USER = user;
  else delete process.env.USER;
  if (osUser === "throws")
    mocks.userInfo.mockImplementation(() => {
      throw new Error("secret os detail");
    });
  else mocks.userInfo.mockReturnValue({ username: osUser });

  assert.equal(await readClaudeCodeAccessToken(), "keychain-token");
  assert.equal(keychainArguments()[1]?.[2], expected);
});

test("uses a valid environment token without reading either credential store", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "environment-token";

  assert.equal(await readClaudeCodeAccessToken(), "environment-token");
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test.each(["bad\ntoken", "bad\rtoken", "bad\u007ftoken", "   ", "two tokens", "unicode-☃"])(
  "rejects an invalid environment token without fallback (%j)",
  async (token) => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;

    await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
      assert.equal(error.message, "Claude Code OAuth token is invalid.");
      assert.ok(!error.message.includes(token));
      return true;
    });
    assert.equal(mocks.execFile.mock.calls.length, 0);
    assert.equal(mocks.readFile.mock.calls.length, 0);
  },
);

test("fails closed for a custom OAuth endpoint before reading the production account", async () => {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://private.example/oauth?secret=do-not-show";
  delete process.env.USER;

  await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
    assert.equal(error.message, "Claude Code custom OAuth endpoints are not supported for usage reporting.");
    assert.ok(!error.message.includes("private.example"));
    return true;
  });
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
  assert.equal(mocks.userInfo.mock.calls.length, 0);
});

test("a custom OAuth origin also blocks environment tokens from reaching production", async () => {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://private.example/oauth";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "environment-token";

  await assert.rejects(readClaudeCodeAccessToken(), /custom OAuth endpoints are not supported/);
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test.each([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
])("does not substitute a stored subscription for an unsupported %s auth source", async (key) => {
  process.env[key] = "private-override-value";
  await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
    assert.match(error.message, /cannot match this Claude Code authentication override/);
    assert.ok(!error.message.includes("private-override-value"));
    return true;
  });
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test.each([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
])("honors the enabled and disabled classes of %s", async (key) => {
  process.env[key] = " FALSE ";
  assert.equal(await readClaudeCodeAccessToken(), "keychain-token");
  mocks.execFile.mockClear();
  for (const enabled of ["1", "true", " YES ", "ON"]) {
    process.env[key] = enabled;
    await assert.rejects(readClaudeCodeAccessToken(), /cannot match this Claude Code authentication override/);
  }
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test("accepts the official API origin and blocks custom or malformed API origins", async () => {
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
  assert.equal(await readClaudeCodeAccessToken(), "keychain-token");
  mocks.execFile.mockClear();
  for (const url of ["https://proxy.invalid/private-secret", "not-a-url"]) {
    process.env.ANTHROPIC_BASE_URL = url;
    await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
      assert.match(error.message, /custom OAuth endpoints are not supported/);
      assert.ok(!error.message.includes(url));
      return true;
    });
  }
  assert.equal(mocks.execFile.mock.calls.length, 0);
});

test("the explicit OAuth environment token takes precedence over a descriptor token", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "environment-token";
  process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "9";
  assert.equal(await readClaudeCodeAccessToken(), "environment-token");
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test("uses an empty environment token as absent and falls through to the selected store", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "";

  assert.equal(await readClaudeCodeAccessToken(), "keychain-token");
  assert.equal(mocks.execFile.mock.calls.length, 1);
});

test.each([44, "44", "ENOENT"])(
  "falls back to the matching file when the Keychain item is missing (%s)",
  async (code) => {
    setKeychainError(code);
    setFileResult(credentials("file-token"));

    assert.equal(await readClaudeCodeAccessToken(), "file-token");
    assert.equal(mocks.readFile.mock.calls.length, 1);
  },
);

test("does not replace an expired or malformed selected Keychain item with a file login", async () => {
  setKeychainResult(credentials("expired-secret", 1000));
  await assert.rejects(readClaudeCodeAccessToken(1000), (error: Error) => {
    assert.match(error.message, /has expired/);
    assertSecretSafe(error, "expired-secret");
    return true;
  });
  assert.equal(mocks.readFile.mock.calls.length, 0);

  setKeychainResult("malformed-secret");
  await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
    assert.equal(error.message, "Claude Code Keychain credentials are invalid.");
    assertSecretSafe(error, "malformed-secret");
    return true;
  });
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test("returns undefined for missing or malformed file credentials and preserves expired-login errors", async () => {
  setPlatform("linux");
  setFileError("ENOENT");
  assert.equal(await readClaudeCodeAccessToken(), undefined);
  assert.equal(mocks.execFile.mock.calls.length, 0);

  setFileResult("malformed-secret");
  assert.equal(await readClaudeCodeAccessToken(), undefined);

  setFileResult(credentials("file-expired-secret", 1000));
  await assert.rejects(readClaudeCodeAccessToken(1000), (error: Error) => {
    assert.match(error.message, /has expired/);
    assertSecretSafe(error, "file-expired-secret");
    return true;
  });
});

test.each([
  {
    code: "ETIMEDOUT",
    detail: "command timed out",
    message: "Timed out reading Claude Code credentials from the macOS Keychain.",
  },
  {
    code: "EACCES",
    detail: "keychain failed; never show this secret",
    message: "Claude Code Keychain access was denied or is unavailable.",
  },
  {
    code: "ELOCKED",
    detail: "keychain failed; never show this secret",
    message: "Claude Code Keychain access was denied or is unavailable.",
  },
  {
    code: "EOTHER",
    detail: "keychain failed; never show this secret",
    message: "Unable to read Claude Code credentials from the macOS Keychain.",
  },
])("fails closed on a Keychain error ($code)", async ({ code, detail, message }) => {
  setKeychainError(code, detail);

  await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
    assert.equal(error.message, message);
    assertSecretSafe(error, "never show this secret");
    return true;
  });
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test("fails closed on non-missing credential file errors without exposing paths or details", async () => {
  setPlatform("linux");
  setFileError("EACCES", "file failed; secret path /private/account");

  await assert.rejects(readClaudeCodeAccessToken(), (error: Error) => {
    assert.equal(error.message, "Unable to read Claude Code credentials file.");
    assertSecretSafe(error, "/private/account");
    return true;
  });
});

test("aborts before any credential read when the signal is already cancelled", async () => {
  const controller = new AbortController();
  controller.abort("secret cancellation reason");

  await assert.rejects(readClaudeCodeAccessToken(Date.now(), controller.signal), (error: Error) => {
    assert.equal(error.name, "AbortError");
    assert.ok(!error.message.includes("secret cancellation reason"));
    return true;
  });
  assert.equal(mocks.execFile.mock.calls.length, 0);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test("forwards Keychain cancellation, terminates the child, and never falls back to file", async () => {
  const controller = new AbortController();
  let childTerminated = false;
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const options = args[2] as { signal?: AbortSignal };
    const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
    options.signal?.addEventListener(
      "abort",
      () => {
        childTerminated = true;
        const error = new Error("cancelled child with secret output");
        error.name = "AbortError";
        callback(error, "secret keychain output", "secret stderr");
      },
      { once: true },
    );
    return undefined;
  });

  const pending = readClaudeCodeAccessToken(Date.now(), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  const childCall = mocks.execFile.mock.calls[0];
  assert.ok(childCall);
  assert.equal((childCall[2] as { signal?: AbortSignal }).signal, controller.signal);
  assert.equal(childTerminated, true);
  assert.equal(mocks.readFile.mock.calls.length, 0);
});

test("Node execFile abort stops a ready child process", async () => {
  const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const controller = new AbortController();
  let resolveChildExit!: (error: Error | null) => void;
  const childExit = new Promise<Error | null>((resolve) => {
    resolveChildExit = resolve;
  });
  const child = childProcess.execFile(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    { signal: controller.signal },
    (error) => resolveChildExit(error),
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) resolve();
    });
  });

  try {
    await ready;
    controller.abort();
    const error = await childExit;
    assert.ok(error);
    assert.equal(error.name, "AbortError");
    assert.equal(child.killed, true);
  } finally {
    controller.abort();
  }
});

test("forwards cancellation to file reading and propagates AbortError without hiding it as a missing login", async () => {
  setPlatform("linux");
  const controller = new AbortController();
  mocks.readFile.mockImplementation(
    (_path: string, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("file read aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  );

  const pending = readClaudeCodeAccessToken(Date.now(), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  const fileCall = mocks.readFile.mock.calls[0];
  assert.ok(fileCall);
  assert.equal((fileCall[1] as { signal?: AbortSignal }).signal, controller.signal);
});

test("the pure credential parser rejects control characters and never includes token data in errors", () => {
  assert.equal(parseClaudeCodeAccessToken(credentials("bad\ntoken"), 1000), undefined);
  assert.equal(parseClaudeCodeAccessToken(credentials("bad\u0000token"), 1000), undefined);
  assert.throws(parseClaudeCodeAccessToken.bind(null, credentials("expired-secret", 1000), 1000), (error: Error) => {
    assert.match(error.message, /has expired/);
    assert.ok(!error.message.includes("expired-secret"));
    return true;
  });
});
