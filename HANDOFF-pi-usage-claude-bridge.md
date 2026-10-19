# Harden Claude usage reporting

This ExecPlan is a living document. Keep Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current. No repository PLANS.md or skill-adjacent PLANS.md exists.

## Purpose / Big Picture

Users of the Claude bridge should see the Claude subscription selected by their Claude Code environment, not another stored account. Cancelling a usage query must stop credential-reading work. The statusline should reveal the selected model's additional weekly cap, and users should be able to choose remaining or used percentages and reset countdowns without changing Codex behavior.

## Progress

- [x] Review the branch against main and reproduce wrong-store selection, uncancelled Keychain subprocesses, and hidden Opus allowance.
- [x] Read extension, settings, README, and ExecPlan conventions; inspect the installed Claude Code credential-store implementation without reading credentials.
- [x] Correct credential selection and cancellation, integrate guarded auth queries and verified configured-provider discovery, and add deterministic regression tests.
- [x] Implement model-aware Claude statusline formatting and persisted Claude statusline preferences with focused tests.
- [x] Update README/provider guidance and the branch's existing changeset; audit the complete touched diff and resolve the independent review's stale-menu cancellation finding.
- [x] Run repository checks and tests, inspect pack contents, and smoke-load the generated package; the full repository suite retains unrelated failures documented below.

## Surprises & Discoveries

The initial branch's seven Claude tests cover only parsing and formatting. The adapter-presence assertion also succeeds when registration is absent. The existing affected-test run passed all 277 package tests but failed an unchanged root startup-benchmark fixture before its child wrote its capture file.

The installed Claude Code distribution contains its credential-store code. The default Keychain service is Claude Code-credentials. A non-empty CLAUDE_CONFIG_DIR adds a suffix consisting of a hyphen and the first eight hexadecimal SHA-256 characters of the NFC-normalized configured path; paths are not resolved or stripped of trailing separators before hashing. An explicitly present CLAUDE_SECURESTORAGE_CONFIG_DIR overrides credential storage: an empty value selects the default store, a non-empty value selects that normalized path and its hash. The Keychain account is USER or os.userInfo().username, restricted to letters, digits, dot, underscore, and hyphen, with claude-code-user as fallback. The matching credentials file lives in that same selected storage directory. A non-empty CLAUDE_CODE_OAUTH_TOKEN overrides stored OAuth tokens. These are provider-owned storage conventions, not a stable public usage API.

The independent auth/runtime review found that discarding a stale menu result did not cancel its credential reader. Every status/menu generation transition now aborts its obsolete controllers through one helper. Eight regression cases cover both cross-provider discovery actions superseded by menu, model, turn, and branch replacement; the reviewer confirmed the finding is resolved without self-cancellation.

## Decision Log

Decision: preserve the existing Claude defaults of remaining percentages and no statusline reset countdown, while adding claudeStatusPercentage and claudeStatusResetCountdown to pi-usage.json and its existing Settings screen. Codex names and behavior stay compatible. Date/author: current implementation session, lead.

Decision: display the general session and weekly caps plus the selected Opus or Sonnet weekly cap; unknown models do not guess a model-specific cap. No custom model ID is printed directly. Date/author: current implementation session, lead.

Decision: credential-store selection never falls back to the default account after a custom directory is chosen. Environment-token selection takes precedence over storage. No login refresh or credential writes are introduced. Auth errors are secret-safe, and cancellation is propagated rather than converted into a missing login. Date/author: current implementation session, lead.

Decision: configured-provider discovery must verify a cross-provider Claude login asynchronously inside a cancellable menu task; synchronous model registration alone is not proof of a configured login. Current-provider auth errors remain observable. Date/author: current implementation session, lead.

## Outcomes & Retrospective

The requested hardening is implemented and the independent auth/runtime review has no remaining blocking findings. Credential selection, auth deadlines, rotation/cache boundaries, configured-provider discovery, model-family caps, persisted preferences, and countdown cleanup are covered by deterministic tests. No login refresh, credential writer, dependency, command route, or duplicate changeset was introduced.

Verification results:

- `npm run format`, final `npm run check`, root test typechecking, and `git diff --check` passed; Biome retains three pre-existing informational diagnostics.
- All 369 `pi-usage` tests passed, including real dummy-child cancellation, TUI cancellation/disposal, non-default cancellation bindings, RPC reports/settings, Codex compatibility, and a fake-token Claude request through Pi's generated Jiti runtime.
- The final complete `npm test` run passed 5,783 of 5,793 tests. Ten failures are confined to unchanged startup-benchmark, Chrome DevTools/Goal/Langfuse loading, LSP/Starship process timing, Subagents preflight, and Sync Git fixtures. An earlier full run had six failures in other unchanged timing fixtures. Canonical-temp-directory, single-worker isolation cleared Subagents and Sync failures but retained the startup capture-file race and Fleet discovery deadline failure. No timeout was increased and no unrelated fixture was edited.
- The package dry run and actual tarball inspection include the declared `dist/index.ts`, Claude source, package-owned docs, and license; the manifest retains one generated entrypoint and external Pi peers. The package-load smoke passed with an isolated `PI_CODING_AGENT_DIR`, and no model request.

The full repository test gate is not clean. Live Claude usage, actual Keychain prompts, external login expiration/refresh, and arbitrary CLI auth helpers remain unverified; mocked credentials/requests and isolated process fixtures were used instead. The existing large runtime module was retained rather than mixing an unrelated menu/lifecycle decomposition into this security fix. No commit, publication, tag, or registry change was made.

## Context and Orientation

packages/pi-usage/src/providers/claude-bridge.ts owns payload normalization and Claude Code credential reading. packages/pi-usage/src/query.ts registers adapters and turns credentials into redacted, fingerprinted request auth. A fingerprint is a salted, non-reversible identifier used to prevent account caches from being reused for another credential. packages/pi-usage/src/usage.ts owns cancellation controllers, query deadlines, menus, statusline timers, and session generations. A generation is a counter used to reject work from an older session or refresh. packages/pi-usage/src/usage-helpers.ts selects configured adapters. packages/pi-usage/src/format.ts renders reports and statusline text. packages/pi-usage/src/settings.ts owns validated settings and atomic persistence; usage-settings-ui.ts exposes them through Pi's SettingsList. Tests reside under packages/pi-usage/test/.

The package source index exports public helpers and forwards its default extension factory; its manifest loads the generated dist/index.ts runtime. Build and loading checks must use that declared entrypoint. The existing .changeset/usage-claude-bridge.md already records the unpublished branch's minor release and should be expanded rather than adding a duplicate release note.

## Touched-Area Rules and Verification

Applicable guides are `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`.

- Runtime/lifecycle MUST keep factory load resource-free, release obsolete/session-owned work, and reject replaced contexts: Review of all generation transitions plus credential/query/runtime and existing lifecycle tests.
- TUI/non-TUI MUST guard custom UI by mode, cancel/dispose owned work, and preserve callback themes/keybindings: real loader-harness cancellation/disposal tests, non-default settings bindings, and RPC/non-interactive compatibility tests.
- Settings MUST follow the settings guide without a competing generic command: defaults/validation, unknown-field preservation, serialized atomic writes, failure rollback, reload ordering, and immediate application tests reuse the existing persistence and SettingsList flow.
- Status MUST use and clear the stable package-owned key: countdown, model/session replacement, and shutdown tests verify `usage` cleanup without extra requests.
- Packaging/documentation MUST preserve the declared independent entrypoint, external peers, Changeset, truthful supported modes, and both verification gates: boundary/type validators, generated Jiti lifecycle/query test, pack inspection, isolated Pi smoke, and README/security audit.

No prompt-cache, tool-activation, shared-terminal-handoff, installation, or extension-boundary policy changed. Live auth verification was intentionally skipped for credential safety; the remaining full-suite failures and retained large runtime module are disclosed above rather than hidden by broader changes.

## Plan of Work

First isolate credential-store selection and a cancellable reader in the Claude provider module. Test environment-token precedence, default/custom/empty/Unicode directory selection, secure-storage overrides, account filtering, absent and expired logins, Keychain and file fallback, and aborts. Thread an optional AbortSignal through resolveUsageAuth without breaking its existing arguments, and use a session/query-owned auth helper to cancel reads when their deadline expires. Add Claude request-boundary and post-response revalidation so changes cannot publish or cache another account's report. Verify cross-provider login availability before showing Claude as configured.

In parallel, update format.ts, settings.ts, and usage-settings-ui.ts. Append an optional Claude options object to formatUsageStatusline so existing Codex callers keep their signature and behavior. Add claudeStatusPercentage (remaining or used, default remaining) and claudeStatusResetCountdown (boolean, default false). Reuse the existing reset-time formatter and settings writer. Add model-aware formatter tests and settings validation/persistence/UI tests. The lead owns usage.ts and its tests and connects the new preferences to publishing and countdown timers.

Finally update README.md and docs/providers.md to disclose separate Claude Code auth, environment/storage precedence, background reads, cancellation, unsupported auth modes, model caps, and settings. Use no new extension-specific environment variables or dependencies. Verify that secrets are never displayed, and compare all changed asynchronous paths against cancellation, disposal, replacement, shutdown, stale-read, and publication requirements.

## Concrete Steps

Run commands from the repository root. Use npm run format for Biome formatting after all owners finish editing. Run npm run check, then npm test separately; do not run either concurrently with a pi-tui-kit build. Root builds regenerate the Kit output needed by consumers. For quicker feedback, build once and use PI_EXTENSIONS_BUILD_READY=1 PI_EXTENSIONS_TEST_BASE=main npm test; the final gate must also attempt the complete npm test suite. Run npm run package:pack -- usage and inspect that dist/index.ts, the Claude module, and package docs are included. Run pi --no-extensions --no-skills -e ./packages/pi-usage --list-models for a non-authenticated package-load smoke. Inspect git diff --check and git status --short before handing off.

## Validation and Acceptance

With a custom store configured and a default login also present, only the custom Keychain service or matching file is read. With CLAUDE_CODE_OAUTH_TOKEN set, no storage read occurs. Cancelling an in-flight Keychain read kills its child and never attempts file fallback. Expired logins fail with the existing refresh instruction without revealing credentials. Missing/expired cross-provider logins are not advertised as configured. Credential rotation during a request prevents stale report publication and cache reuse.

For a selected Opus model with Session 98%, Weekly 76%, and Weekly Opus 0% remaining, the default statusline includes the exhausted Opus cap rather than only healthy global percentages. Used-percentage and countdown choices persist through the existing JSON settings and apply immediately. Default Codex outputs and command modes remain unchanged. Regression tests use mock credentials and requests, not user stores or live provider calls, and every test stays inside the repository's 5-second timeout.

## Idempotence and Recovery

All changes are source, deterministic tests, and documentation. Readers never mutate credentials. Settings use the existing serialized temporary-file-plus-rename writer and preserve unknown fields. Builds can be repeated and generated output is ignored by Git. Do not publish, tag, change registry visibility, or commit without user instruction. If a sandbox or provider smoke fails, diagnose and report the boundary rather than retrying around it; deterministic tests remain the fallback.

## Artifacts and Notes

Review reproductions used fake tokens and showed:

    callerAborted: true, childStillRunning: true, childReceivedSignal: false
    customConfigIgnoredWhenDefaultLoginExists: true
    opusRemaining: 0, statusline: claude 98% 5h 76% wk

## Interfaces and Dependencies

Use Node's crypto hash for provider-compatible Keychain names, child_process.execFile with AbortSignal for cancellation, and fs/promises.readFile with cancellation for file fallback. Keep secrets in memory only. Existing Pi, TUI Kit, and Vitest dependencies suffice. Retain parseClaudeCodeAccessToken as a pure parser and the public resolveUsageAuth positional arguments; any new cancellation argument is optional and appended. The new formatter options object has optional showResetCountdown and percentage fields and is appended after the existing Codex percentage argument.

Revision note: replaced the stale pre-implementation handoff with an executable plan after the user approved fixing the review findings; updated completion, independent-review resolution, semantic audits, verification evidence, and remaining limitations after implementation.
