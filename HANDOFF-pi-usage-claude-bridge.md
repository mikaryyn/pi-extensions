# Handoff: add Claude (claude-bridge) support to pi-usage

## Goal
`/usage` in Pi currently prints `Usage reporting is not supported for claude-bridge.` when the active model is
`claude-bridge/claude-sonnet-5-5`. Add a `claude-bridge` adapter to the pi-usage fork so `/usage` shows the
Claude subscription limits.

## State
- **No code has been written.** The sandbox allows read-only access to `/Users/mika.ryynanen/code`, so all writes to
  the clone failed (`nono why`: "insufficient_access"). Only `/Users/mika.ryynanen/code/temp` is writable.
- Fork location: `/Users/mika.ryynanen/code/pi-extensions/packages/pi-usage` (package `@narumitw/pi-usage` 0.61.1).
- The fork has no `node_modules`. The monorepo root is `/Users/mika.ryynanen/code/pi-extensions` and has its own `package.json` and `package-lock.json`. Run `npm install` there first.
- The installed (upstream) copy Pi currently loads is `~/.pi/agent/npm/node_modules/@narumitw/pi-usage`.
  `~/.pi/agent/settings.json` lists the packages, including `npm:pi-claude-bridge`. To use the fork, point the
  `pi-usage` entry at the fork path instead. Check the `packages` array format there first.

## Findings
1. **Why it is unsupported:** `src/query.ts` has a hard-coded `SUPPORTED_ADAPTERS` list plus `XAI_ADAPTER`.
   `adapterForProvider(model.provider)` returns nothing for `claude-bridge`, so `queryCurrentState` in
   `src/usage.ts` (about line 511) produces the "not supported" message.
2. **Data source verified working** (HTTP 200, tested with curl):
   ```
   GET https://api.anthropic.com/api/oauth/usage
   Authorization: Bearer <Claude Code OAuth access token>
   anthropic-beta: oauth-2025-04-20
   ```
   The endpoint is undocumented, so it may change. Relevant response fields (many others are null or have opaque names, so ignore them):
   - `five_hour` / `seven_day`: `{utilization: 2.0, resets_at: "2026-09-30T15:09:59.79+00:00", ...}`. `utilization` is a percent.
   - `seven_day_opus`, `seven_day_sonnet`: null on this plan, but should be handled when present.
   - `extra_usage`: `{is_enabled: true, used_credits: 74.0, currency: "EUR", decimal_places: 2, monthly_limit: null, ...}`. `used_credits` looks like minor units (74 = EUR 0.74), and `spend.used.amount_minor` agrees.
   - `limits[]`: `[{kind:"session", percent:2, severity, resets_at}, {kind:"weekly_all", percent:24, ...}]`.
3. **Credentials:** `pi-claude-bridge` has no Pi-registry credential. It authenticates through the Claude Code login.
   - macOS keychain: `security find-generic-password -s "Claude Code-credentials" -w` returns JSON: `{"claudeAiOauth": {"accessToken": ..., "expiresAt": <ms>, ...}}`.
   - On other platforms: `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`). This file does not exist on this machine.
   - The auth path in `resolveUsageAuth` (`src/query.ts`) goes through `ctx.modelRegistry.getProviderAuth`, `hasOfficialOrigin` and similar. That doesn't fit claude-bridge, so it needs an early bypass.
4. **Adapter shape** (`UsageProviderAdapter` in `src/types.ts`): `{id, displayName, semantics, publishesStatusline?, query(auth, signal, timeoutMs, guard?, targetId?)}`.
   The Copilot adapter is the smallest example. `fetchProviderJson(url, auth, signal, timeoutMs, description, {redirect:"error"})` does the fetch, bounded reads and redaction, and sends `auth.headers`.
   `src/providers/codex.ts` is a good model for percent buckets: `{id,label,groupId,groupLabel,used,remaining,limit:100,unit:"percent",windowMinutes,resetsAt}`. `resetsAt` is epoch **seconds**.

## Planned implementation
1. **`src/providers/claude-bridge.ts` (new):**
   - Constants: provider id `claude-bridge`, the usage URL, and the beta header value `oauth-2025-04-20`.
   - `normalizeClaudeOAuthUsagePayload(payload, capturedAt): UsageReport`:
     - Buckets from `five_hour` (300 min, id `five-hour`, label "Session"), `seven_day` (10080 min, id `weekly`), and `seven_day_opus` / `seven_day_sonnet` when non-null.
     - `used = utilization`, `remaining = 100 - min(100, used)`, `limit = 100`, `unit = "percent"`, and `resetsAt = floor(Date.parse(resets_at) / 1000)`.
     - Metric `extra-usage` ("Extra usage spent", `unit:"currency"`, `currency` from the payload, `value = used_credits / 10 ** decimal_places`) when `is_enabled`.
     - Throw if there are no buckets and no metrics, like the other normalizers.
     - `semantics = {kind: "consumer-subscription", label: "Claude subscription limits"}`, provider name "Claude", source `claude-oauth-usage`.
   - `readClaudeCodeAccessToken(now)`:
     - Try the keychain via `execFile("security", [...])` on darwin only, with a 5 s timeout, then fall back to the credentials file.
     - If `expiresAt <= now`, throw "Claude Code login has expired. Run `claude` once to refresh it." Do not refresh the token or write it back.
     - Never log or return the token in error text.
2. **`src/types.ts`:** add `ClaudeOAuthUsagePayload = {five_hour?, seven_day?, seven_day_opus?, seven_day_sonnet?, extra_usage?}` (all `unknown`, matching the other payload types).
3. **`src/query.ts`:**
   - Export `CLAUDE_BRIDGE_ADAPTER` (`id: "claude-bridge"`, `displayName: "Claude"`, `query` calls `fetchProviderJson` with `{redirect:"error"}` and the normalizer). Add it to `usageAdapters()`.
   - At the top of `resolveUsageAuth`, add `if (adapter.id === "claude-bridge") return resolveClaudeBridgeUsageAuth(ctx, salt)`. That function:
     - Finds `candidateModels(ctx, "claude-bridge")[0]`, returning undefined if there is none.
     - Reads the token, returning undefined if there is none.
     - Returns `{apiKey: token, headers: {Authorization: "Bearer …", "anthropic-beta": "oauth-2025-04-20"}, fingerprint: fingerprintResolvedAuth({headers}, salt), secrets: [token, "Bearer …"], model}`.
   - In `providerIsConfigured`, return `candidateModels(ctx, id).length > 0` for `claude-bridge`.
   - The token must only ever go to the fixed Anthropic URL. Skip `hasOfficialOrigin`, because the bridge model's `baseUrl` is not the real API.
4. **`src/index.ts`:** export `normalizeClaudeOAuthUsagePayload`, `CLAUDE_BRIDGE_ADAPTER` and the `ClaudeOAuthUsagePayload` type (next to the existing exports).
5. **`test/claude-bridge.test.ts` (new)**, in the style of `test/adapters.test.ts` (vitest + `node:assert/strict`):
   - Normalizer on the real response shape above. Expect two buckets, resets in seconds, and a EUR 0.74 metric.
   - Opus and Sonnet buckets appear when non-null.
   - Empty or garbage payloads throw.
   - `formatUsageReport(report, "current")` renders sensibly.
   - Optionally, `adapterForProvider("claude-bridge")` is defined, and the credential parser handles an expired token, a missing token and malformed JSON. If you want that, split the JSON-to-token parsing into a pure function so it is testable without touching the keychain.
6. **Docs:** add `claude-bridge` to `docs/providers.md` and the README supported list. Note that the endpoint is undocumented and that the login comes from Claude Code. Add a `CHANGELOG.md` entry. Consider adding `claude` to the `package.json` keywords.
7. **Statusline:** `formatUsageStatusline` in `src/format.ts` has per-provider branches (for example `formatZaiStatusline`). Either set `publishesStatusline: false` for now, or add a small `claude` branch such as `claude 24% wk`. Check how unknown providers behave first.

## Verify
From the monorepo root or the package (check the root `package.json` scripts): `npm install`, then in `packages/pi-usage`: `npm run check` (build + biome + typecheck) and the vitest suite (root has `vitest.config.ts`). Follow `/Users/mika.ryynanen/code/pi-extensions/AGENTS.md`.
Manual test: launch Pi with the fork loaded, use a `claude-bridge` model, and run `/usage`. Expected: Session about 2%, Weekly about 24% (values vary), and the extra-usage metric.

## Open questions and risks
- **Undocumented endpoint:** it could change or be restricted. Keep the normalizer defensive.
- **Token refresh:** deliberately not handled. An expired token gives a clear error. Claude Code refreshes it when it runs.
- **Keychain prompt:** the first `security` read may show a macOS access dialog, so choose "Always Allow" or expect one prompt.
- **Upstreaming:** the upstream package is `@narumitw/pi-usage`. A PR would need the maintainer to accept an adapter that reads another tool's credentials. That may be contentious, so keep the credential reader isolated and easy to remove.
- **Sandbox:** if the next session is also sandboxed, launch Pi with write access to the fork, for example `nono run --profile pi --allow /Users/mika.ryynanen/code/pi-extensions -- pi`.
