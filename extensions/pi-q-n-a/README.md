# pi-q-n-a

Ask the user questions from the model.

`pi-q-n-a` gives pi a single `pi-q-n-a` tool that asks up to a handful of
multiple-choice questions in one form: tabs across questions, single- and
multi-select, an inline **Type something** row, per-question **notes**, optional
side-by-side **previews**, and a submit screen that accepts partial answers.

```
─ ← ■ Scope   □ Priority   ✓ Submit →
──────────────────────────────────────────────────────────────────────────────
 Which database should the service use?

 > 1. Postgres                        ┌─ Postgres ─────────────────────────┐
      Battle-tested, relational.      │ CREATE TABLE users (               │
   2. SQLite                          │   id uuid primary key,             │
      Embedded, zero-ops.             │   ...                              │
   3. Type something.                 └────────────────────────────────────┘
   Skip this question

 Notes: ctrl+n to add a note
 ↑↓ move · Enter select · type to answer · ctrl+n note · Esc cancel
──────────────────────────────────────────────────────────────────────────────
```

The **Type something** row is an ordinary numbered row, but it is a live text
field: move onto it and type, or just start typing anywhere and the cursor jumps
there. There is no separate box. `Enter` uses the text as the answer; in a
multi-select question it is added alongside the checkboxes. `Esc` leaves the row.

## Usage

The model calls the tool; the user drives the form with the keyboard.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move the cursor |
| `Enter` | Single-select: choose and advance. Multi-select: advance with the current set |
| `Space` | Multi-select: toggle the highlighted option |
| Any printable key | Jump to the **Type something** row and start typing |
| `Tab` / `Shift+Tab` / `←` / `→` | Move between questions and the Submit tab |
| `Ctrl+N` | Add or edit a note for the current question |
| `Enter` on **Type something** | Use the typed answer |
| `Esc` / `Ctrl+C` in the form | Interrupt the tool (aborts the turn, like Escape on any pi tool) |

Every question also has a **Skip this question** row, and the Submit tab accepts
unanswered questions, so nothing forces a complete form.

Notes use `Ctrl+N` rather than plain `n` so that `n` can be typed into the
answer field.

## What each question can carry

- **Options** — 1 to 5, each with a label, an optional one-line description, an
  optional stable `value`, and an optional `recommended` flag (rendered as
  `(Recommended)`).
- **Type something** — an inline, numbered text row, always present unless the
  model sets `allowOther: false`. In a multi-select question it is additive:
  checkboxes plus your typed text.
- **Notes** — a free-text note per question, independent of the answer. Notes are
  included in the result and the tool tells the model to treat them as
  authoritative context.
- **Previews** — a short model-authored mockup (ASCII layout, small diagram, or
  brief code snippet) shown beside the options. `previewLanguage` adds syntax
  highlighting; without it the text renders verbatim monospace, which is what
  ASCII art wants. Previews are **hidden for multi-select questions** and shown
  side by side when the terminal is wide enough, stacked below otherwise.
  Previews are clipped to 24 lines.

## The result

The model receives a transcript:

```
Q: Which database should the service use?
A: Postgres
User note: must support logical replication
Q: Which screens?
A: (skipped)
```

and `details` carries the structured `questions` / `answers` / `interrupted`
data used to render the summary in the transcript. The summary shows one line
per question with the chosen labels and a clearly marked note line.

## How it works

- One `pi.registerTool()` with `exposure: "model-only"` (declared to the model,
  not callable through codemode) and `executionMode: "sequential"`.
- The form is an `ctx.ui.custom()` component. `Input` from
  `@earendil-works/pi-tui` backs the inline "Type something" row (its
  `placeholder` is the preview text) and `Editor` backs notes; `highlightCode()`
  from `@earendil-works/pi-coding-agent` highlights code previews.
- `Esc` calls `ctx.abort()` after the component resolves, so interrupting the
  form behaves like interrupting any other pi tool.
- The tool is TUI-only. In other modes it returns an error result telling the
  model to ask in plain text.

## Layout constants

`layout.ts` owns the split: `MIN_OPTION_WIDTH = 28`, `MIN_PREVIEW_WIDTH = 32`,
`COLUMN_GAP = 3`, preview span 38% of the terminal clamped to 30–60 columns,
`MAX_PREVIEW_LINES = 24`.

## Caveats

- `highlightCode()` colors with pi's global theme singleton rather than the
  theme passed to the component. They are the same object during a render; a
  mid-form theme reload could briefly mismatch syntax colors.
- The tool name uses hyphens; providers allow `[A-Za-z0-9_-]`, so this is safe.
