import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark", false);

type TestComponent = {
  dispose?(): void;
  handleInput(data: string): void;
  render(width: number): string[];
};

test("Claude settings save immediately and remain applied when a remapped cancel key closes the screen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-claude-ui-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pi-usage.json");
  const runtime = createUsageSettingsRuntime(path);
  await runtime.reload();
  const previousKeybindings = getKeybindings();
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "j",
    "tui.select.confirm": "x",
    "tui.select.cancel": "q",
  });
  setKeybindings(keybindings);
  t.onTestFinished(() => setKeybindings(previousKeybindings));

  let component!: TestComponent;
  let initialFrame = "";
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    custom: (factory: unknown) =>
      new Promise<boolean>((resolve) => {
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: { bold(text: string): string; fg(_color: string, text: string): string },
            keybindings: object,
            done: (result: boolean) => void,
          ) => TestComponent
        )({ requestRender() {} }, { bold: (text) => text, fg: (_color, text) => text }, keybindings, (result) => {
          component.dispose?.();
          resolve(result);
        });
        initialFrame = component.render(100).join("\n");
        markReady();
      }),
  });
  const applied: string[] = [];
  const pending = showUsageSettings(
    ctx,
    runtime,
    new AbortController().signal,
    () => true,
    (id) => applied.push(id),
  );
  await ready;

  for (let index = 0; index < 4; index += 1) component.handleInput("j");
  component.handleInput("x");
  await settleSettingsSave(runtime);
  const afterCountdown = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const countdownState = runtime.get().settings.claudeStatusResetCountdown;

  component.handleInput("j");
  component.handleInput("x");
  await settleSettingsSave(runtime);
  const afterPercentage = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  component.handleInput("q");

  assert.equal(await pending, true);
  assert.match(initialFrame, /Claude reset countdown/u);
  assert.match(initialFrame, /Claude percentage/u);
  assert.equal(afterCountdown.claudeStatusResetCountdown, true);
  assert.equal(countdownState, true);
  assert.equal(afterCountdown.claudeStatusPercentage, undefined);
  assert.equal(afterPercentage.claudeStatusResetCountdown, true);
  assert.equal(afterPercentage.claudeStatusPercentage, "used");
  assert.equal(runtime.get().settings.claudeStatusPercentage, "used");
  assert.deepEqual(applied, ["claudeStatusResetCountdown", "claudeStatusPercentage"]);
});

async function settleSettingsSave(runtime: ReturnType<typeof createUsageSettingsRuntime>): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await runtime.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
