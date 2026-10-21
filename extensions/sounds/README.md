# sounds

Audio feedback for pi, driven entirely by the [`hooks`](../hooks/) bus. It
plays a sound when a session starts or ends, a prompt is submitted, the agent
starts or settles, a tool starts or completes, compaction is coming, or a
permission dialog opens.

This extension is deliberately independent from [`notify`](../notify/): notify
owns desktop banners, sounds owns audio, and they share no code.

## Configuration

Under `sounds` in `~/.pi/agent/settings.json` and `.pi/settings.json`. A bare
filename is resolved against `directory`; `null` disables an event.

The **Classic** suite is bundled with the extension and is the default, so
sounds work with no configuration at all. `directory` accepts a bundled suite
name (`Classic`) or any path, and `events` overrides the mapping.

```json
{
  "sounds": {
    "enabled": true,
    "directory": "Classic",
    "player": "afplay",
    "volume": 0.7,
    "debounceMs": 150,
    "events": {
      "SessionStart": "session_start.wav",
      "UserPromptSubmit": "prompt_submit.wav",
      "PreToolUse": "tool_start.wav",
      "PostToolUse": "tool_complete.wav",
      "AgentSettled": "response_end.wav",
      "PreCompact": "precompact_warning.wav",
      "PermissionRequest": "permission_request.wav",
      "PostToolUseFailure": null
    }
  }
}
```

### Default mapping

| Event | File |
| --- | --- |
| `SessionStart` | `session_start.wav` |
| `SessionEnd` | `session_end.wav` |
| `UserPromptSubmit` | `prompt_submit.wav` |
| `AgentStart` | `response_start.wav` |
| `Stop` | `stop.wav` |
| `AgentSettled` | `response_end.wav` |
| `PreToolUse` | `tool_start.wav` |
| `PostToolUse` | `tool_complete.wav` |
| `PostToolUseFailure` | `tool_complete.wav` |
| `PreCompact` | `precompact_warning.wav` |
| `PermissionRequest` | `permission_request.wav` |
| `Notification` | `notification.wav` |

Event names are the hooks engine's names, so Claude's vocabulary works as-is.
The suite lives in [`assets/Classic`](assets/Classic/) and comes from
[ClaudeCodeSounds](https://github.com/AutumnsGrove/ClaudeCodeSounds) (MIT, see
[`assets/LICENSE`](assets/LICENSE)). Subagent cues are omitted: pi has no
subagents. Point `directory` at another folder (for example the `drift` suite
from that repository) to swap the whole set.

### Players

Autodetected: `afplay` on macOS, `paplay` then `aplay` on Linux, `powershell`
on Windows. `player` overrides it, and any custom player is called as
`<player> <file>`. Volume is applied where the player supports it
(`afplay -v`, `paplay --volume`).

Playback is detached and never blocks a run. A missing file or player is
ignored. The same file will not play twice within `debounceMs`, which keeps a
parallel tool batch from firing the completion sound repeatedly.

## Permission cue

The hooks engine never dispatches `PermissionRequest`, so the
[`permissions`](../permissions/) extension emits `pi-permissions:prompt` when
it opens a dialog. Sounds listens for that channel and plays the
`PermissionRequest` mapping.

## Commands

- `/sounds` — show the mapping.
- `/sounds on|off` — toggle for this session.
- `/sounds test [event]` — play one mapping.
- `/sounds dir <path>` — change the suite directory for this session.
- `/sounds reload` — re-read settings.

`--mute` starts with sounds disabled.

## Requirements

The [`hooks`](../hooks/) extension must be enabled: sounds registers one
observe-only handler per hook event and does nothing on its own. Both ship in
this package and load together.
