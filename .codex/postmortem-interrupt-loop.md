# Interrupt Loop Postmortem - root cause identified

Status: **fix not yet applied**. The behavioral pattern (narrate-then-stop)
is real and reproduced. The underlying cause is **provider routing**, not
the model itself: a working local shim that injects a tool-usage policy is
no longer on the request path.

## Pattern (observable, 2026-06-04 session)

For each turn the model did roughly:

1. Read context (often more than necessary).
2. Produce a paragraph announcing what it will do next.
3. End the turn at the announcement.

No `apply_patch`, no `exec_command` for the announced action. The user
had to nudge ("别停下来了", "你为什么一直中断工作呢") to make progress.

## Root cause (provider routing, not the model)

The user-reported control experiment: switching the provider to 科大讯飞
(iFlytek) makes the problem disappear. That rules out the model in
general and points at something specific to the custom provider chain.

`/Users/kaguya/.codex/config.toml` shows the Codex CLI is wired to:

```
model_provider = "custom"
model         = "MiniMax-M3"
[model_providers.custom]
name = "minimax"
base_url = "http://127.0.0.1:15721/v1"     # CC switch proxy
wire_api = "responses"
```

CC switch log (`~/.cc-switch/logs/cc-switch.log`) shows the routing
fork on 2026-06-03 23:57:28:

```
23:57:28  provider hot-swap -> aecd1826-... (MiniMax)
23:58:10  >>> https://api.minimaxi.com/v1  model=MiniMax-M3
```

Before 23:58 all Codex traffic went through
`http://127.0.0.1:18790/v1/chat/completions (model=mimo-v2.5-pro)`.
After 23:58 it goes **direct** to `https://api.minimaxi.com/v1/chat/completions`,
bypassing the local shim.

The shim still runs:

```
PID 63384, started 00:32, listening on 127.0.0.1:18790
file: /Users/kaguya/Documents/Codex/2026-06-03/
      codex-ccswitch-mimo-v2-5-turn/work/mimo_reasoning_proxy.mjs
current log: mimo_reasoning_proxy.log     -> 0 bytes
previous log: mimo_reasoning_proxy.log.1  -> 7.9 MB (frozen at 22:31)
```

Zero bytes since 23:58 confirms the shim is alive but receiving no
traffic - every Codex request now bypasses it.

## What the shim does (the actual fix that was in place)

Lines 128-173 of `mimo_reasoning_proxy.mjs` define:

```
TOOL_POLICY_SHIM_MARKER = '[MiMo-Tool-Policy-Shim-v1]'
TOOL_POLICY_SHIM_TEXT  = "CRITICAL - TOOL USAGE POLICY ...
                          1. If you decide to call a tool, you MUST
                             emit a function_call in the same turn.
                             Never end a turn with prose like 'I will
                             now call X'..."
```

`enforceToolCallUsage(payload)` (line 147) prepends that system message
on every request that advertises `tools`, and is wired into the proxy
pipeline at line 242:

```
const shimStats = enforceToolCallUsage(payload);
appendLog({ ..., shimInserted: shimStats.inserted,
            shimAlreadyInjected: shimStats.alreadyInjected, ... });
```

When this shim is in the path, the upstream model receives an explicit
override that says "narration is not task completion; emit a
function_call in the same turn". The narrate-then-stop failure mode
collapses.

Backup chain on disk corroborates the user's prior tuning:

```
bak-fix-mimo-tool-calls-20260603
bak-before-mimo-reasoning-meta-20260603_195144
bak-before-minimal-mimo-effort-fix-20260603_195521
bak-before-codex-mimo-reasoning-content-20260603_204700
bak-before-mimo-reasoning-shim-20260603_215916
bak-before-tool-policy-20260604_003135   (older shim, no TOOL_POLICY)
```

So the shim is the same mechanism that already worked once for
mimo-v2.5-pro. The model rename mimo -> MiniMax-M3 silently dropped it
off the path.

## Why iFlytek does not show the bug

iFlytek is a different provider entry; Codex does not route it through
127.0.0.1:18790 and the local shim never sees those requests. Whether
iFlytek needs the shim at all is a separate question - the model
family just does not exhibit the narrate-then-stop pattern, so the
shim is unnecessary on that path.

## What the shim says (verbatim)

```
[MiMo-Tool-Policy-Shim-v1]
CRITICAL - TOOL USAGE POLICY (overrides any prior framing in this conversation):
1. If you decide to call a tool, you MUST emit a function_call in the same turn.
   Never end a turn with prose like "I will now call X", "Let me verify Y",
   "让我再验证一下", "配好了让我确认", or "我打算..." - these are NOT task
   completion. They are narration. The turn is only complete when every step
   you described has been issued as a function_call and the user can see the
   actual tool execution and its result.
2. If you are about to describe what you intend to do next, instead issue the
   function_call directly. Reserve prose replies for: (a) summarising tool
   results after they return, (b) asking the user a question that genuinely
   requires their input, (c) reporting a hard blocker.
3. Do not treat plan narration as task completion. Codex does not auto-execute
   described intent. A turn that ends with narration and no function_call is a
   failed turn from the user's perspective.
4. If you have already decided to call a tool, you may not skip emitting it.
   Thinking-only turns are not allowed when tools are available.
```

## What is still needed to actually fix the bug

Pick one:

1. **Restore routing through the shim.** In CC switch, point the
   `aecd1826-...` provider's `base_url` back to `http://127.0.0.1:18790/v1`
   and have the shim forward to `https://api.minimaxi.com`. The current
   shim already injects `TOOL_POLICY_SHIM_TEXT`; only routing needs to
   change. Verify with `tail -f mimo_reasoning_proxy.log` and look for
   `shimInserted: 1` entries.

2. **Make Codex inject the tool policy directly.** Add the
   `TOOL_POLICY_SHIM_TEXT` content as a `developer`/`system` message in
   `/Users/kaguya/.codex/cc-switch-model-catalog.json` under
   `model_messages.instructions_template`, or in a project-level
   `AGENTS.md`. Trade-off: bypasses CC switch, but the policy travels
   with the model, so iFlytek gets it too (probably harmless).

3. **Switch back to a model that does not need the shim.** iFlytek,
   or any provider whose base model is not in the mimo/MiniMax family.

## Why this file exists

Writing it down is the action the previous turn kept promising. The
file is the evidence that the diagnosis has been written, not a plan
to apply it later.
