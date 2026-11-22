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
| `AttentionChanged:needs_you` | `notification.wav` |
| `AttentionChanged:ready` | `ready_to_merge.wav` |
| `AttentionChanged:idle` | `response_end.wav` |
| `AttentionChanged:working` | `(off)` |
| `AttentionChanged:waiting` | `(off)` |

Event names are the hooks engine's names, so Claude's vocabulary works as-is.
The suite lives in [`assets/Classic`](assets/Classic/) and comes from
[ClaudeCodeSounds](https://github.com/AutumnsGrove/ClaudeCodeSounds) (MIT, see
[`assets/LICENSE`](assets/LICENSE)). Subagent cues are omitted: pi has no
subagents. Point `directory` at another folder (for example the `drift` suite
from that repository) to swap the whole set.

One file is not from that suite: `ready_to_merge.wav` is generated for this
repository (three decaying bell notes, E5 → G5 → B5 at 0, 90 and 180 ms, each
with a soft octave partial, 22050 Hz mono 16-bit, 0.62 s) and is covered by this
repository's MIT license. It is the cue for a PR the agent deliberately released
as done.

### Players

Autodetected: `afplay` on macOS, `paplay` then `aplay` on Linux, `powershell`
on Windows. `player` overrides it, and any custom player is called as
`<player> <file>`. Volume is applied where the player supports it
(`afplay -v`, `paplay --volume`).

Playback is detached and never blocks a run. A missing file or player is
ignored. The same file will not play twice within `debounceMs`, which keeps a
parallel tool batch from firing the completion sound repeatedly.

## Attention takeover

When [`pi-attention`](../pi-attention/) is loaded it decides, after a turn
settles, whether that turn needed you — which the hooks engine cannot know. So
it takes over the settle cue: `Stop` and `AgentSettled` stop playing, and the
`AttentionChanged:<state>` mapping is what you hear. A passing-CI wake that
needed nothing is `waiting`, which is silent, so the string of identical
"finished" sounds goes away; `needs_you` and `ready` get distinct cues.

`idle` (an ordinary turn) keeps `response_end.wav`, so nothing changes for
sessions without attention. Set `attention: false` to keep the old double cue
even when `pi-attention` is loaded.

```json
{ "sounds": { "attention": true } }
```

The takeover is keyed on a flag `pi-attention` sets when it loads, so it works
regardless of which extension loads first, and stops when attention is disabled.

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
