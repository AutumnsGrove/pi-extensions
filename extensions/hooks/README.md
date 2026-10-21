# hooks

A Claude Code-compatible hook engine for pi. Hooks are declared in
`settings.json` using Claude's event names and nesting, and run as shell
commands, HTTP requests, or one-shot model judgments. Pi's own event names are
accepted as aliases.

This extension is the engine only. Sounds, permissions, and anything else are
separate consumers (see "In-process bus").

## Configuration

Hooks live under the `"hooks"` key. Global hooks come from
`~/.pi/agent/settings.json`; project hooks from `.pi/settings.json`. Pi
deep-merges the two, and project values win — including replacing an event's
whole matcher list.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|write|edit",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.pi/hooks/check_command.py",
            "timeout": 10
          },
          {
            "type": "prompt",
            "prompt": "Is this tool call safe and within the user's intent? $ARGUMENTS",
            "model": "openrouter/anthropic/claude-haiku-4",
            "onFailure": "block"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "afplay ~/sounds/session_start.wav &" }
        ]
      }
    ]
  }
}
```

### Matchers

- Omitted, `"*"`, or `""` matches every event.
- A string made only of letters, digits, `_`, `-`, space, `,`, and `|` is an
  exact list: `"bash|write|edit"`, `"startup,resume"`.
- Anything else is an unanchored JavaScript regular expression:
  `"^mcp__jira__"`.
- Tool events match on `tool_name`; `SessionStart` on `source`; `SessionEnd`
  on `reason`; `PreCompact`/`PostCompact` on `trigger`; `PostModelSwitch` on
  the model id; `FileChanged` on `file_path`.

### `if` rules

A handler-level `if` filters tool events with Claude's permission-rule syntax.
Only one rule is allowed, and it applies to `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, and `PermissionDenied`.

```json
{ "type": "command", "command": "./check.sh", "if": "Bash(git *)" }
```

Examples: `Bash(rm -rf *)`, `Edit(*.ts)`, `Read(src/**)`, `mcp__jira__*`.
Bash rules test the command; file tools test the path; `grep`/`find` test the
pattern; other tools test the JSON input.

## Handler types

| `type` | What it does | Required |
| --- | --- | --- |
| `command` | Runs a process. Event JSON on stdin; result from exit code + stdout. | `command` |
| `http` | POSTs the event JSON. Response body uses the JSON output schema. | `url` |
| `prompt` | One-shot model judgment. Must answer `{"decision":…,"reason":…}`. | `prompt` |
| `agent` | Reserved. Not implemented in v1; config warns. | `prompt` |

Common fields: `if`, `timeout` (seconds; 600 command/http, 30 prompt, 60 agent),
`async`, `asyncRewake`, `once`, `statusMessage`, `onFailure`
(`"continue"` default, `"block"` turns a crash or timeout into a deny).

`command` adds `args` (presence switches to exec form, no shell) and `shell`
(`"bash"` or `"powershell"`). `http` adds `headers` and `allowedEnvVars`.

`async` hooks run in the background and their output is discarded, so an async
`PreToolUse` hook cannot block. `once` removes the hook after its first
successful run for the current session.

## Exit codes and output

| Exit | Meaning |
| --- | --- |
| `0` | Success. A JSON object on stdout is applied. |
| `2` | Blocking error on blocking events. stderr is the reason. On post events it becomes feedback to the model. |
| other | Non-blocking error, unless `onFailure: "block"`. |

```json
{
  "decision": "deny",
  "reason": "refusing to delete the home directory",
  "additionalContext": "the user asked for a read-only review",
  "systemMessage": "shown to the user",
  "updatedInput": { "command": "ls -la" },
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "writes outside the repo"
  }
}
```

`deny` beats `ask` beats `allow`. `continue: false` stops the run.
`updatedInput` merges field-by-field; `updatedToolOutput` replaces a tool
result. Command hooks receive `CLAUDE_PROJECT_DIR`, `CLAUDE_HOOK_EVENT`,
`PI_PROJECT_DIR`, `PI_CWD`, `PI_HOOK_EVENT`, `PI_SESSION_ID`, and
`PI_TRANSCRIPT_PATH`.

## Supported events (v1)

| Config event | Pi event | Notes |
| --- | --- | --- |
| `SessionStart` | `session_start` | `source` is `startup`, `resume`, `clear`, or `fork`. |
| `SessionEnd` | `session_shutdown` | `reason` mapped to Claude's vocabulary; 1.5s budget. |
| `UserPromptSubmit` | `input` | `deny` swallows the prompt; `additionalContext` is appended. |
| `PreToolUse` | `tool_call` | `allow`/`ask`/`deny`, `updatedInput`, block. |
| `PostToolUse` | `tool_result` (success) | `updatedToolOutput`, `additionalContext`. |
| `PostToolUseFailure` | `tool_result` (error) | stderr becomes feedback. |
| `PermissionRequest` | in-process bus | Emitted by the permissions extension. |
| `PermissionDenied` | in-process bus | Emitted by the permissions extension. |
| `Stop` | `agent_before_settle` | Observe-only in v1; cannot force a continuation. |
| `PreCompact` | `session_before_compact` | `deny` cancels compaction. |
| `PostCompact` | `session_compact` | |
| `PostModelSwitch` | `model_select` | |
| `FileChanged` | synthesized | Fires after a successful `write`/`edit`, with `file_path` and `change_type`. |
| `UserBash` | `user_bash` | Observe-only. |
| `TurnStart` / `TurnEnd` | `turn_start` / `turn_end` | |
| `AgentStart` / `AgentEnd` / `AgentSettled` | `agent_start` / `agent_end` / `agent_settled` | |
| `MessageEnd` | `message_end` | |
| `ToolExecutionStart` / `ToolExecutionEnd` | `tool_execution_start` / `tool_execution_end` | |
| `SessionCompactFailed` | `session_compact_failed` | |
| `ThinkingLevelSelect` | `thinking_level_select` | |

The rest of Claude's events (`Notification`, `SubagentStart`, `ConfigChange`,
`CwdChanged`, `WorktreeCreate`, …) are not exposed by pi 1.x. They load with a
warning rather than silently doing nothing. Pi's session `cwd` is fixed, so
`CwdChanged` has no meaning here.

## In-process bus

Other extensions can register typed handlers without a subprocess. The hooks
extension announces itself with `pi-hooks:ready`; consumers register (or
re-register) on that event:

```ts
const register = () => {
  pi.events.emit("pi-hooks:register", {
    event: "PreToolUse",
    matcher: "bash",
    source: "my-extension",
    handler: (input) => ({ decision: "deny", reason: "not today" }),
  });
};

pi.events.on("pi-hooks:ready", register);
register();
```

Handlers receive the same `HookInput` as command hooks and may return a
`HookOutput` or nothing. `pi-hooks:unregister` with `{ source }` removes all of
a source's handlers.

## Commands

- `/hooks` — list loaded hooks grouped by event.
- `/hooks reload` — re-read settings (also happens on `session_start`).
- `/hooks validate` — print configuration warnings.
- `/hooks debug` — show whether `PI_HOOKS_DEBUG=1` is active.

Set `PI_HOOKS_DEBUG=1` before starting pi to log dispatch decisions to stderr.

## Differences from Claude Code

- No core patches. Everything is built on pi's extension events.
- `Stop` cannot force another model turn; it observes.
- `agent` hooks are not implemented. Use `prompt`, or the permissions
  extension's classifier provider.
- `once` is session-scoped, not skill-scoped.
- Project `hooks` replace global `hooks` for the same event (pi's settings
  merge replaces arrays). Use different events or a single file to layer.
- Claude's `defer` decision is treated as `ask`.
