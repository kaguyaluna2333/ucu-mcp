# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
