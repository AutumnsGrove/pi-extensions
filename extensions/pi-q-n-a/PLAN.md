# Plan: pi-q-n-a

## Why

Pi's built-in interactions are single-purpose: `ctx.ui.select()` asks one
question with a flat list, and `ctx.ui.confirm()` asks yes/no. When the model
needs several decisions at once, or a choice with a small mockup next to it, the
only option is a wall of prose. Claude Code's `AskUserQuestion` tool solves this
with a multi-question form: tabs, single- and multi-select, an always-present
"Other", a review screen, and per-option previews.

`pi-q-n-a` brings that shape to pi, with three deliberate differences:

1. **Skips are first class.** Every question can be skipped, and the form can be
   submitted with unanswered questions. There is no gating "you must answer
   everything" state.
2. **Notes are respected.** The user can attach a free-text note to any answer
   (`n`). Notes are carried into the tool result on their own line and the tool
   declares a guideline telling the model to treat them as authoritative.
3. **It looks like pi, not Claude.** Pi's semantic theme tokens, pi's help
   hints, and a compact summary rendered into the transcript after submit.

## What pi gives us

Investigated against pi `0.99.2`:

- `pi.registerTool()` with `exposure: "model-only"` — the documented exposure
  for tools that "orchestrate other tools or ask the user". Declared to the
  model, never callable through `executeTool()`/codemode.
- `ctx.ui.custom(factory)` — a component gets keyboard focus and resolves when
  it calls `done(result)`. This is the only way to run a multi-step keyboard UI.
- `Editor` from `@earendil-works/pi-tui` for the inline "type something" and
  note editors, with `onSubmit`, `handleInput`, `render`, `setText`.
- `highlightCode(code, lang)` from `@earendil-works/pi-coding-agent` for
  syntax-highlighted code previews; it returns themed lines.
- `wrapTextWithAnsi`, `visibleWidth`, `truncateToWidth` for ANSI-aware layout.
- `ctx.abort()` on the tool context — aborts the current agent operation, which
  is exactly pi's Escape-to-interrupt semantics.

Pi examples `question.ts` and `questionnaire.ts` cover single-select, tabs, and
the inline editor. We reuse those patterns and add multi-select, previews,
notes, skips, and interrupt handling.

## Interaction

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← ■ Scope   □ Priority   ✓ Submit →                                       │
│                                                                            │
│ Which database should the service use?                                     │
│                                                                            │
│ > 1. Postgres                         ┌─ Postgres ───────────────────────┐  │
│      Battle-tested, relational.       │ CREATE TABLE users (             │  │
│   2. SQLite                           │   id uuid primary key,           │  │
│      Embedded, zero-ops.              │   ...                            │  │
│   3. Type something.                  └──────────────────────────────────┘  │
│   Skip this question                                                       │
│                                                                            │
│ Notes: ctrl+n to add a note                                                │
│                                                                            │
│ ↑↓ move · Enter select · type to answer · ctrl+n note · Esc cancel         │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Tabs** (`Tab` / `Shift+Tab` / `←` / `→`) move between questions and the
  Submit tab; `□` unanswered, `■` answered, `–` skipped.
- **`↑`/`↓`** move the cursor.
- **Single-select:** `Enter` on an option records it and advances.
- **Multi-select:** `Space` toggles a checkbox, `Enter` advances with the
  current set. Nothing checked + `Enter` is a skip.
- **Type something:** an ordinary numbered row (unless `allowOther: false`)
  that is a live `Input` rendered in place, with a `Type something.`
  placeholder. There is no separate box. Move the cursor onto it and type, or
  type on any row and the cursor jumps there. `Enter` uses the text; in a
  multi-select question it is additive to the checkboxes.
- **Skip:** the trailing `Skip this question` row advances without an answer.
- **`Ctrl+N`:** opens the note editor for the current question; `Enter` saves,
  `Esc` cancels. Notes are per-question and independent of the answer. A
  modified key is used so plain `n` can be typed into the answer field.
- **`Esc` / `Ctrl+C`:** interrupts the tool (calls `ctx.abort()`), like
  pressing Escape during any other pi tool. No partial result is submitted.
- **Submit tab:** lists every question, its answer (or "skipped") and its note.
  `Enter` submits; unanswered questions are allowed.

## Previews

- A per-option `preview` string authored by the model: ASCII layout, a small
  diagram, or a short code snippet. `previewLanguage` selects syntax
  highlighting; without it the text renders verbatim monospace.
- Preview pane appears for **single-select** questions when at least one option
  in that question has a preview. When the cursor is on an option without a
  preview the pane shows a muted placeholder, so the layout does not jump.
- **Multi-select questions never show previews** (matching the reference).
- Layout: side by side when the terminal is wide enough, otherwise the preview
  stacks below the options. `chooseLayout()` owns the thresholds
  (`MIN_OPTION_WIDTH = 28`, `MIN_PREVIEW_WIDTH = 32`, `COLUMN_GAP = 3`,
  preview span 38% of width clamped to 30–60).
- Previews are clamped to `MAX_PREVIEW_LINES = 24`, with a dim "… (N more
  lines)" row, so a runaway mockup cannot swallow the transcript.

## Result contract

`details` (branch-following, used by the transcript renderer):

```ts
interface QuestionnaireDetails {
  questions: QuestionSpec[];
  answers: AnswerRecord[];
  interrupted: boolean;
}

interface AnswerRecord {
  id: string;
  selections: string[]; // selected option values
  custom?: string;      // "Type something" text
  note?: string;        // user note
  skipped: boolean;
}
```

Model-facing `content` renders each question, its answer, and any note:

```
Q: Which database should the service use?
A: Postgres
User note: must support logical replication
Q: Which screens?
A: (skipped)
```

`promptGuidelines` tells the model that user notes are authoritative context and
must be incorporated, which is the behaviour we found lacking in the reference.

## Rendering in the transcript

`renderCall` shows `pi-q-n-a` plus the tab labels. `renderResult` renders the
summary the user asked for: one line per question with the chosen labels, plus a
clearly marked note line, or a warning when interrupted.

## Files

```
extensions/pi-q-n-a/
├── index.ts              # registerTool, execute, renderCall/renderResult
├── schema.ts             # TypeBox schemas + shared types
├── questionnaire.ts      # pure helpers + QuestionnaireComponent
├── layout.ts             # column layout, preview box, composeColumns
├── component.test.ts     # keyboard interaction regressions
├── index.test.ts         # registration + execute + renderers
├── questionnaire.test.ts # pure helpers
├── layout.test.ts        # column math + preview box
├── PLAN.md
└── README.md
```

## Risks

- Custom component owns keyboard focus; pi's global Escape handler does not run,
  so we call `ctx.abort()` ourselves after `Esc` resolves the component. If pi
  changes `ExtensionContext.abort()`, interrupt falls back to "close the form
  and return an interrupted result".
- `highlightCode` uses pi's global theme singleton rather than the theme passed
  to the component. In practice they are the same object during a render; a
  theme reload mid-form could briefly mismatch syntax colors.
- Preview layout is heuristic. Widths are tested at the boundaries; other
  terminals may pick a different but valid arrangement.
