# permissions

A rules + classifier permission model for pi, built on the
[`hooks`](../hooks/) engine. Every tool call is judged before it runs; the
decision is logged and can be replayed later for benchmarking.

```
tool call
  → session grant?
  → deny / ask / allow rules        (bash is split into segments)
  → mode
      default      ask on anything risky
      acceptEdits  auto-allow edits inside the project
      auto         classifier verdict, fail closed
      dontAsk      deny anything unmatched, never prompt
      bypass       allow unless a deny rule matched
  → dialog, or deny when there is no UI
```

It registers a `PreToolUse` handler on the hooks bus. If the hooks extension
is not loaded it falls back to pi's `tool_call` event, so it works standalone
and never double-prompts.

## Configuration

Under `permissions` in `~/.pi/agent/settings.json` and `.pi/settings.json`.
Claude's `defaultMode` and `allow` / `ask` / `deny` arrays are accepted as-is.

```json
{
  "permissions": {
    "mode": "auto",
    "defaultDecision": "ask",
    "allow": ["Bash(git status)", "Edit(src/**)"],
    "ask": ["Bash(npm publish *)"],
    "deny": ["Bash(rm -rf /)", "Read(.env)"],
    "reviewTools": ["bash", "powershell", "write", "edit"],
    "persistGrants": true,
    "reviewer": {
      "provider": "jev",
      "model": "openrouter/~typesafe/jev-latest",
      "fallbackModel": "openrouter/anthropic/claude-haiku-4",
      "fallbackToLlm": true,
      "approveAt": 0.9,
      "dangerAt": 0.9,
      "timeoutSeconds": 20,
      "cache": true
    },
    "log": { "enabled": true, "fullState": false }
  }
}
```

Rules are additive on top of a conservative built-in set: read-only shell
commands, pi's read-only tools, and hard denies (`rm -rf /`, `sudo`, `mkfs`,
`curl | bash`, …). Set `"useDefaultRules": false` to start empty. Deny always
wins, then ask, then allow.

## Modes

| Mode | Behaviour |
| --- | --- |
| `default` | Rules decide; ask for risky calls that no rule covers. |
| `acceptEdits` | Auto-allow `write`/`edit` inside the project; ask otherwise. |
| `auto` | Rules, then a classifier; ask only when the classifier is unsure. |
| `dontAsk` | Never prompt; deny anything unmatched. |
| `bypass` | Allow everything except explicit denies. |

`plan` mode is intentionally absent: pi has no read-only planning mode.

Switch with `/permissions mode <name>`, the `--permission-mode` flag, or the
`alt+m` / `ctrl+shift+m` shortcut. `--yolo` starts in bypass. `shift+tab` is
already pi's thinking-level cycle, which is why the mode shortcut differs.

## Auto mode

The reviewer receives one compact state object: the tool, its input, the cwd,
the user's last prompt, and recent bash commands.

**JEV** (the default) runs through pi's classifier API. It answers five typed
questions — destructive, exfiltration, user intent, scope, risk — and the
thresholds turn probabilities into a verdict. It is fast, produces no output
tokens, and needs no prompt engineering.

**LLM** fallback runs when JEV is unavailable and `fallbackToLlm` is on. If
both fail, the verdict is `deny`: auto mode fails closed, never open.

Verdicts are cached for the session by `hash(tool, input, cwd)`; only settled
`allow` / `deny` verdicts are cached, never `ask`.

## Grants

The prompt offers four choices:

- **Allow once** — nothing is remembered.
- **Allow for this session** — held in memory, cleared on the next session.
- **Always allow** — also appends the rule to project `.pi/settings.json`
  (only when the project is trusted).
- **Deny**.

Grants are keyed by the exact call, so a grant for `git status` cannot approve
`git status && rm -rf /`.

## Logging

Every decision appends a redacted JSONL line to
`.pi/permissions/decisions.jsonl` (with a `.gitignore` so it is never
committed) and a compact `permissions-decision` entry to the session. Secrets,
tokens, and credential-shaped keys are masked; `log.fullState` disables
redaction and should only be used in throwaway projects.

The recorded `tool`, `input`, and reviewer verdict are enough to replay a call
through JEV and an LLM later and compare outcomes — the JEV-vs-LLM benchmark.

## Commands

- `/permissions` — mode, reviewer, rule counts, grants, cache.
- `/permissions mode <default|acceptEdits|auto|dontAsk|bypass>`
- `/permissions allow|ask|deny <rule>` — persist a rule to project settings.
- `/permissions review <jev|llm|off>`
- `/permissions log [n]` — recent decisions.
- `/permissions clear` — drop session grants and cached verdicts.
- `/permissions test <tool> '<json>'` — show how a call would be judged
  without running a reviewer or prompting.

## Differences from Claude Code

- No `plan` mode and no subagent reviewer; the classifier runs in-process.
- `allow for session` is memory-only; only `always allow` is persisted.
- Bash is segmented rather than fully parsed. Commands using `$(...)`,
  backticks, heredocs, `eval`, or `source` are never auto-allowed; `bash -c`
  and `eval` are judged on their inner command when it can be read statically.
- Output redirection blocks read-only allow rules, so `cat x > y` asks.
- The reviewer sees a compact state, not the full transcript.
