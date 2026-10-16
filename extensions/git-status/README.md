# git-status

A live git status widget for pi, rendered on its own line just above the footer
(below the editor) — separate from the extension status line that the provider,
search, and usage extensions already share.

```
⎇ feature/x · 3 modified · +42 −8 · ↑1 ↓2
⎇ main
```

## What it shows

| Segment | Meaning |
| --- | --- |
| `⎇ feature/x` | Current branch; `(d86d48d)` with parentheses when HEAD is detached. |
| `3 modified` | Number of changed files, each path counted once. Untracked files count individually, not as their parent directory. Hidden when the tree is clean. |
| `+42 −8` | Uncommitted insertions and deletions, including the lines in untracked files. Hidden when the tree is clean. |
| `↑1 ↓2` | Commits ahead of / behind the upstream. Shown only when the branch tracks one. |

The line is truncated to the terminal width, so it degrades gracefully in a
narrow pane.

## How the line counts are computed

Insertions and deletions follow
[`ccstatusline`](https://github.com/fredericosantos/ccstatusline), the Claude
Code status line this widget mirrors: it sums the unstaged working tree and the
index, so the numbers cover everything not yet committed.

```
git diff --shortstat          # unstaged
git diff --cached --shortstat # staged
```

Neither diff includes untracked files, which would make a brand-new file
invisible and the widget under-report the work on disk. So the lines in
untracked files are read and added as insertions. Binary files and files over
1 MiB are skipped.

Branch, tracking drift, and file counts come from a single
`git status --porcelain -z --branch -uall`. `-uall` is what lists every
untracked file instead of collapsing a directory into one `?? dir/` entry. All
commands run with `--no-optional-locks` so the widget can never trip over an
`index.lock`, and each is capped at five seconds.

## Refreshing

The widget refreshes after tools run, at the end of each turn, and after user
`!` shell commands. Bursts collapse through a 250 ms debounce, and a refresh
requested while another is running is coalesced into one follow-up, so a rapid
run of edits costs a handful of git calls, not one per event.

Add or commit files from another terminal and the widget will not notice until
the next event — run `/git-status` to force it.

## Command

| Command | Effect |
| --- | --- |
| `/git-status` | Refresh and print a detailed summary (branch, upstream drift, per-bucket file counts, line churn). |
| `/git-status on` \| `off` | Show or hide the widget for the session. |

Outside a git repository the widget hides itself.
