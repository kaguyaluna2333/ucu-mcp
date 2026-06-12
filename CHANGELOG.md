# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-06-11

### Changed

- `UcuError` base class now has a formal `hint?: string` field with serialization in `toJSON()`. Platform errors that carry remediation hints (e.g. `WindowNotFoundError` from `focusApp` for Electron apps) now pass the hint through the constructor instead of using duck-type property assignment. (Fox 0.3.8 M1)
- `findElementInputSchema` export annotated with `@internal` — not part of the public API, may change without semver bump. (Raman 0.3.7 M4)
- `list_windows` empty-result branch now uses the top-level `checkPermission` import instead of a per-call dynamic `import()`. (Fox 0.3.8 M2)
- `doctor` `tried` arrays are now `readonly string[]` and no longer silently truncated via `.slice(0, 3)`. (Fox 0.3.8 N2/N3)
- Text-side and value-side regex pre-validation tests consolidated into a single `it.each` parameterized case. (Raman 0.3.7 N2)

### Fixed

- `find_element` now attaches a pixel-level fallback hint when it returns 0 results AND `scannedCount === 0` for a specific app (meaning the AX tree is empty — common with Electron/Chromium apps). The hint directs the model to use `screenshot` + `ocr` + `click(x, y)` instead of retrying `find_element` forever.
- CHANGELOG 0.3.7 `prepublishOnly` description now matches the actual script (`npx vitest run tests/unit/ && npm run build` instead of `npm test && npm run build`). (Raman 0.3.7 M2)
- CHANGELOG 0.3.7 scope claim "corrected in both `src/platform/macos.ts` and this CHANGELOG" narrowed to "corrected in this CHANGELOG" — the source file was already correct. (Raman 0.3.7 M3)
- CHANGELOG 0.3.5 duplicate "three fewer" / "two fewer" entry cleaned up — only the corrected "two fewer" version remains. (Raman 0.3.7 N4)
- Test comment "modern V8" clarified to "Node >= 12 / V8" for the all-no-bounds near-sort test. (Raman 0.3.7 N1)

### Tests

- 225 unit tests pass (13 test files).
- `macos`: value-side and text-side regex pre-validation tests consolidated into single `it.each` with preserved regression context.
- Verified on Node v22.22.3 / macOS 26.6 (arm64).

### Fixed

- **JXA return values fixed (P0)**: Three JXA scripts (`click_element`, `type_in_element`, `set_value`) called `JSON.stringify({success:…})` as a bare statement — the result was computed but discarded, so the osascript output was empty and `JSON.parse(out)` would fail or return undefined. Now each script assigns to `_result` and calls `JSON.stringify(_result)` once at the end.
- **Rate-limit timestamp ordering (P0)**: `lastActionTime` was updated before the user-activity pause check. If the pause blocked the action, the rate-limit window was consumed anyway, causing subsequent retries to also be rate-limited. Now `lastActionTime` is set only after both checks pass.
- **Window cache concurrency guard (P0)**: `listWindows` could be called concurrently (e.g. `validateActiveTarget` + `list_windows` tool). Two overlapping calls could write `windowCache` at the same time, producing torn reads. Added `windowCacheInFlight` flag — concurrent callers return stale data instead of racing.
- **`validateActiveTarget` checks pid (P1)**: Previously only checked windowId, missing the case where an app restarts and the OS reuses the same window ID. Now also checks pid match.
- **`focusApp` failure clears stale target (P1)**: When `focusApp` threw `WindowNotFoundError`, the old `activeTarget` was retained. Subsequent AX tools would try to use the dead target. Now `activeTarget` is cleared on failure.
- **`get_screen_size` goes through `withSafety` (P1)**: Was the only tool that bypassed the safety/permission/retry pipeline. Now wrapped in `withSafety` for consistent error handling and rate limiting.

### Tests

- 225 unit tests pass (13 test files).
- MCP stdio smoke: `doctor`, `list_windows`, `list_apps`, `get_screen_size` all return valid responses.
- All 3 JXA scripts now produce valid JSON output (verified via stdio pipe test).


## [0.3.8] - 2026-06-08

### Fixed

- `focus_app` no longer trips the user-activity pause. It used to be classified as `"other"` (neither observe nor input) so a recent mouse movement could block `focus_app` for 2 s; it is now in `OBSERVE_ACTIONS`, matching the production `withSafety` default. Symptom: OpenCode could not switch the active target app (e.g. CC Switch) without retrying until the cursor had been still for 2 s.
- `doctor` native-helper path resolution now checks `process.argv[1]` (npm / npx / global install), walks `import.meta.url` up to 4 levels, and falls back to `npm root -g`. Previously, when the MCP client launched `ucu-mcp` from a cwd other than the project root (the common case for `npx ucu-mcp`), the helper binaries would report as missing even though they were in the tarball. The new report includes `path` and a `tried[]` list so the model can see what was checked.
- `doctor` recommendations now list each missing macOS permission on its own line, name the host terminal app (so the user knows which entry to grant in System Settings), and add an Electron AX hint for the common case where `list_windows` returns `[]` even with Accessibility granted.

### Tests

- `safety-guard`: `focus_app` is in `OBSERVE_ACTIONS`; `classifyAction("focus_app") === "observe"`; `withSafety`'s default `skipUserActivityPause` lets the call through even mid user-activity.
- `errors`: `WindowNotFoundError` preserves an inline `hint` field set by the platform layer, surfaced in the MCP error response.
- `macos-platform`: OCR JXA `"Failed to load screenshot image"` is re-thrown as `CaptureError` with a hint pointing at the missing Screen Recording permission (the typical cause is `screencapture` writing a 0-byte file when TCC denies Screen Recording, not the helper binary being absent).
- `tools-layer`: `doctor` report carries `terminalApp` and the richer `nativeHelpers = { cgevent, ocr } = { ok, path, tried[] }` shape.

## [0.3.7] - 2026-06-07

### Fixed

- `find_element` value-schema test is no longer a tautology. The 0.3.6 release fixed a *symptom* of the bug (the old test called `handler()` directly, bypassing the McpServer schema-validation wrapper, and then asserted `r.isError === true` which was `undefined`); the underlying tautology remained: the test re-created a local `z.string().min(1).optional()` instead of exercising the real schema. 0.3.7 exports the actual `findElementInputSchema` from `src/mcp/tools.ts` and the test now imports it via `findElementInputSchema.value`, so the assertion genuinely pins the production schema. Pins the 0.3.2 commit `46d4ddd` semantic.
- CHANGELOG/JXA `textMatches` comment math is now correct: 3 sources → 1 RegExp = **2 fewer** compilations per matched element. The 0.3.5/0.3.6 wording "three fewer" was off by one and has been corrected in this CHANGELOG (the `src/platform/macos.ts` comment was already correct at that point).

### Tests

- `macos-platform`: text-side regex pre-validation now has a regression test mirroring the existing value-side test (`findElement({text:"[", textMode:"regex"})` throws `PlatformError` with an `Invalid regex pattern` message). Pins the original text-side guard that the 0.3.2 commit mirrored onto the value side.
- `macos-platform`: all-no-bounds edge case for the `near` sort — when every result is missing `bounds`, the original JXA order is preserved. Pins the 0.3.2 commit `0710eca` no-bounds fallback against a future refactor that introduces a non-stable comparator.

### Hygiene

- `findElementInputSchema` is now a named export from `src/mcp/tools.ts` (with a JSDoc comment explaining why the schema is exported) so the unit test can assert the production schema directly instead of constructing a local copy.
- Added `prepublishOnly` script to `package.json` that runs `npx vitest run tests/unit/ && npm run build` before `npm publish`. This is a structural guard against the yank rhythm that hit 0.3.3 and 0.3.5: a failed test or build will now block the publish at the npm level, not at the human level. (Raman review Minor #3)

## [0.3.5] - 2026-06-06  *(Yanked — see 0.3.6)*

### Tests

- `macos-platform`: new regression test for the value-field regex pre-validation (`findElement({value:"[", textMode:"regex"})` throws `PlatformError` with an `Invalid regex pattern` message). Pins the 0.3.2 commit `0710eca` behavior change.
- `macos-platform`: new regression test for the near-sort bounds fallback (elements without `bounds` are pushed to the end of the sorted result, instead of implicitly being centered at (0,0)). Pins the 0.3.2 commit `0710eca` second behavior change.
- `tools-layer`: new regression test that `find_element({value:""})` returns `isError: true`. Pins the 0.3.2 commit `46d4ddd` schema tightening (`z.string().min(1).optional()`).

### Changed

- JXA `textMatches` regex branch now compiles the `RegExp` once per element instead of once per source (name / value / description) — **two** fewer compilations per matched element when `textMode="regex"` (corrected in 0.3.7; 0.3.5/0.3.6 said "three fewer" which was off by one: 3 sources → 1 regex = 2 saved). The TS-side pre-validation in `findElement` guarantees the pattern is valid, so the `RegExp` constructor cannot throw here. (Herschel review perf Minor)

### Fixed

- Comment on the JXA `matchesValue` helper no longer claims "JXA function declarations are order-sensitive" (they aren't — JXA hoists them like any ES engine). The comment now correctly notes that the leading placement is for readability. (Herschel review comment Minor)

## [0.3.6] - 2026-06-06

### Re-publish of 0.3.5

0.3.5 was published with a test that didn't account for the McpServer
schema-validation wrapper. The test called `handler({value:""})`
directly, which bypasses the schema validation, so the assertion
`r.isError === true` saw `undefined` instead. The actual fix
(asserting the zod schema constraint directly) was a one-test rewrite;
0.3.6 carries the same code as 0.3.5 plus the test fix.

### Yanked

`ucu-mcp@0.3.5` was unpublished (yanked) within minutes of release
due to the broken test. Users on `@latest` are now on 0.3.6.

## [0.3.4] - 2026-06-06

### Re-publish of 0.3.3

0.3.3 was published with a syntax error in the source test file
(`tests/unit/tools-layer.test.ts:355` was a continuation of a `//`
comment block that lost its `//` prefix on a hard line break, so
tsc parsed the second line as a bare identifier). The published
npm tarball was functionally correct (`dist/` was unaffected), but
the broken test file would fail to compile for any consumer
running `npm test` against the source. The fix (a single-character
comment prefix) was applied, but npm disallows re-publishing the
same version, so the fixed source ships as 0.3.4 with the same
contents and CHANGELOG entry as 0.3.3 plus this note.

### Yanked

`ucu-mcp@0.3.3` was unpublished (yanked) shortly after release due to
the test file compile error. Users on `@latest` are now on 0.3.4.

## [0.3.3] - 2026-06-06  *(Yanked — see 0.3.4)*

### Tests

- `tools-layer`: three new test cases cover `wait_for_element` value+textMode combinations (contains, exact, regex). They confirm the response surfaces the matched value unchanged so the model can branch on it. (Completes Singer Item 4)

### Refactor

- JXA `textMatches` and `valueMatches` consolidated through a shared `matchesValue(filter, value, mode)` helper. No behavior change; the three branches (contains / exact / regex) now live in one place. (Completes Singer Item 8)

## [0.3.2] - 2026-06-06

### Bug fixes

- `find_element` with `textMode="regex"` now pre-validates the `value` field for invalid regex patterns and throws `PlatformError`, mirroring the existing `text`-field validation. Before, an invalid value regex was silently swallowed by the JXA-internal `try/catch` and surfaced as "no results" instead of a clear error. (Singer Minor)
- `find_element` `near` sort now explicitly pushes elements without `bounds` to the end of the sorted result, instead of implicitly treating them as centered at (0,0). Improves semantics for elements without on-screen geometry. (Singer Nit)

### Changed

- `find_element.value` schema is now `z.string().min(1).optional()`. Empty strings are now rejected at the schema layer with a clear validation error rather than being silently coerced to "no filter". (Singer Minor)

### Tests

- `macos-platform`: the `index out of range` test now also pins `metrics.matchedCount` to the JXA return value, locking the semantic that out-of-range indexing does not change the underlying match count. (Singer Minor)

### Tool description

- `find_element` tool description expanded to mention `value` / `index` / `near` selector support, so the model sees the new selectors at the tool level rather than only on individual parameters. (Singer Minor)
- `UcuError.defaultCode` lookup now has a JSDoc cross-reference explaining the relationship between the static class default and the per-instance `code` field. (Singer Minor)

### Hygiene

- Tracked 7 files removed from git tracking: `.codex/{config.toml,postmortem-interrupt-loop.md}`, `.claude/{settings.json,settings.local.json,.cozempic-init.lock}`, `docs/{.DS_Store,superpowers/.DS_Store}`. These were local-environment residue that predated the `.gitignore` rules; the ignore rules were already in place, just not enforced on the existing tracked entries. `claude-desktop-config.json` (the root-level sample for Claude Desktop MCP setup) was kept.

## [0.3.1] - 2026-06-06

### Bug fixes

- `wait_for_element` `until="value_change"` mode no longer spins until timeout when the matched element's initial `value` is `undefined` (e.g. progress indicators / status text without an AX value). A separate `hasInitial` flag now tracks "first sample captured" so a captured `undefined` is preserved as the baseline. On timeout, `value_change` mode now reports `"never_appeared"` (no match ever found) vs `"value_unchanged"` (match found but value did not change) so the model can branch on the result. (Singer review Major fix)

### Note

Post-0.3.0 release changes already merged on `main` and folded into 0.3.1:

- Scenario-based MCP `instructions` covering forms, menu bar, screen read, app switch, verify action, wait for UI, recover from `TARGET_STALE`, clipboard read/write. (47dbcff)
- `find_element` multi-strategy: new `value` (textMode-aware), `index` (Nth match), `near` (distance-sorted) selectors. (47dbcff)
- `wait_for_element` `until` parameter: new modes `appear` (default), `disappear`, `value_change`. (47dbcff)
- `UcuError` class static `code` renamed to `defaultCode` to avoid clashing with the instance `code` field. (eec7afd)

## [0.3.0] - 2026-06-06


### Added

- Scenario-based MCP Instructions — tool-usage guidance organized by task pattern (form fill, menu bar click, screen read, app switch, verify action, wait for change, recover stale target, clipboard)
- findElement multi-strategy: `value` filter (AX value, respects textMode), `index` selector (0-based Nth match), `near` sorter (ascending distance to point)
- wait_for_element `until` parameter: `appear` (default), `disappear` (poll until gone), `value_change` (poll until first match value differs)
- Action Receipt v1 — unified receipt structure for all action-class tools (click, double_click, scroll, drag, move, type_text, press_key, click_element, set_value, type_in_element)
- Receipt fields: actionId (base36-timestamp unique ID), action, status (ok/partial/blocked), target (location context), result (business result), capture (screenshot metadata), warnings, next (suggested next step)
- Partial receipt when action succeeds but post-action screenshot fails: status="partial", capture.error contains error details, warnings includes "Post-action screenshot capture failed"
- Target Session v1 — `focus_app` now returns stable target metadata (`targetId`, `appName`, `pid`, `windowId`, `title`, `capturedAt`) for follow-up tool calls
- `TARGET_STALE` structured errors for active target windows that disappear before `get_window_state`

### Changed

- MCP instructions rewritten from generic description to scenario-driven workflow recommendations
- `wait_for_element` description updated to reflect `until` parameter semantics
- `find_element` schema extended with `value`, `index`, `near` parameters
- Action tool responses now wrap business results under `result` instead of returning them at the top level
- captureAfter failures now surface through receipt.capture.error instead of a flat captureError object
- `get_window_state` can use the prior `focus_app` target when `windowId` is omitted
- AX tools (`find_element`, `wait_for_element`, `click_element`, `set_value`, `type_in_element`) can use the prior `focus_app` target when `app` is omitted

- Rewrote `src/mcp/tools.ts` with comprehensive 22-tool registry:
  - Unified `withSafety` wrapper for all automation actions
  - `captureAfter` helper for post-action screenshots
  - `windowId` guard for window-scoped operations
  - Integrated safety report in `doctor` output

### Security

- Security audit fixes applied:
  - Input validation on all tool parameters
  - Safe handling of file paths and URLs
  - Rate limiting considerations for rapid automation

### Architecture

- `ARCHITECTURE.md` rewritten to document:
  - FocusStealSuppression implementation
  - UserInteractionMonitor design
  - Safety layer architecture
  - Tool registry patterns

[0.1.0]: https://github.com/2876674942/ucu-mcp-backup/releases/tag/v0.1.0
