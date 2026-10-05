/**
 * pi-tasks — a small task-list primitive for pi.
 *
 * Gives the model one `todo` tool (create / update / delete / list) and renders
 * the list as a live panel above the editor. State lives entirely in the tool
 * result's `details`, so it is rebuilt from the active branch on session start,
 * compaction, and tree navigation — no disk writes, survives `/reload`.
 *
 * The panel shows up to five unfinished tasks, keeps the in_progress task in
 * view, and omits completed tasks (the heading keeps the count). `/todos`
 * prints every task grouped by status.
 *
 * Because prompt guidelines alone don't make every model maintain the list, the
 * extension also nudges: a drift reminder after a working turn that skipped the
 * list, and one forced reconciliation request when a run is about to end with
 * unfinished tasks. Both nudges are hidden from the TUI.
 *
 * Deliberately smaller than rpiv-todo: no dependency graph, tombstones, owner,
 * metadata, config file, i18n, or turn-based fading.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	CustomMessageEntryDraft,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	applyTodoMutation,
	emptyState,
	formatCompactReminder,
	formatTaskNudge,
	replayFromBranch,
	type Todo,
	type TodoDetails,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./state.ts";

const TOOL_NAME = "todo";
const COMMAND_NAME = "todos";
const WIDGET_KEY = "pi-tasks";
const REMINDER_TYPE = "pi-tasks";
const DRIFT_RESEND_TURNS = 3;
const MAX_PANEL_ROWS = 5;

const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "delete", "list"] as const, {
		description: "create a task, update it, delete it, or list all tasks",
	}),
	subject: Type.Optional(
		Type.String({ description: "Short imperative task subject (required for create, mutable on update)" }),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update and delete)" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "New status when action is update",
		}),
	),
	activeForm: Type.Optional(
		Type.String({
			description:
				"Present-continuous label shown while in_progress, e.g. 'writing tests' (update; empty string clears it)",
		}),
	),
});

const PROMPT_SNIPPET = "Maintain a visible task list to track multi-step work";

const PROMPT_GUIDELINES = [
	"Use `todo` for work with 3+ steps, or as soon as you receive a list of tasks. Skip it for a single trivial step or a purely conversational reply.",
	"Mark a task in_progress (with activeForm) before starting it, and completed immediately when it is done. Never batch completions, and keep at most one task in_progress at a time.",
	"Never mark a task completed if tests are failing or the work is partial; leave it in_progress or create a new task for the blocker.",
	"Keep subjects short and imperative. Use update with an id to refine a subject, change status, or set activeForm; use delete to drop a task.",
];

// ---------------------------------------------------------------------------
// Session state — one slot per session id. A detached child session can never
// read or overwrite the foreground list; only the primary UI session owns the
// panel.
// ---------------------------------------------------------------------------

const sessions = new Map<string, TodoState>();
let primarySession = "";
let panelCtx: ExtensionContext | undefined;
let panelRegistered = false;

// Per-run enforcement bookkeeping, reset on `agent_start`. `runTouchedTodos`
// gates every nudge so leftover tasks from an earlier session never nag.
let runTouchedTodos = false;
let runDidWork = false;
let runReconciled = false;
let lastNudgeSignature = "";
let lastNudgeTurn = -DRIFT_RESEND_TURNS;

const sid = (ctx: { sessionManager: { getSessionId(): string } }): string =>
	ctx.sessionManager.getSessionId() ?? "";

const stateFor = (sessionId: string): TodoState => sessions.get(sessionId) ?? emptyState();

/** Hidden custom-message entry used for the drift and settle nudges. */
function nudgeEntry(content: string): CustomMessageEntryDraft {
	return { type: "custom_message", customType: REMINDER_TYPE, content, display: false };
}

/** Stable signature of the list, used to throttle repeated drift nudges. */
function taskSignature(state: TodoState): string {
	return state.todos.map((t) => `${t.id}:${t.status}:${t.subject}`).join("|");
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

function statusGlyph(status: Todo["status"], theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "◐");
		default:
			return theme.fg("dim", "○");
	}
}

function renderPanel(todos: Todo[], theme: Theme, width: number): string[] {
	const done = todos.filter((t) => t.status === "completed").length;
	// Completed tasks drop out of the panel; the heading keeps the count and
	// `/todos` shows the full list on demand.
	const active = todos.filter((t) => t.status !== "completed");
	// Start blank: no panel until there is at least one unfinished task.
	if (active.length === 0) return [];
	const heading = `${theme.fg("accent", "●")} ${theme.fg("accent", `Tasks (${done}/${todos.length})`)}`;
	const lines = [truncateToWidth(heading, width, "…")];

	const { visible, hidden } = selectPanelRows(active, MAX_PANEL_ROWS);
	for (let i = 0; i < visible.length; i++) {
		const isLast = hidden === 0 && i === visible.length - 1;
		lines.push(renderRow(visible[i]!, isLast, theme, width));
	}
	if (hidden > 0) {
		lines.push(
			truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more · /todos`)}`, width, "…"),
		);
	}
	lines.push(""); // breathing room between the panel and the editor
	return lines;
}

/**
 * Pick the rows the panel shows. Active (non-completed) tasks stay in list
 * order; if the list overflows, the in_progress task is pinned into view so the
 * thing being worked on never scrolls off.
 */
function selectPanelRows(active: Todo[], budget: number): { visible: Todo[]; hidden: number } {
	if (active.length <= budget) return { visible: active, hidden: 0 };
	const visible = active.slice(0, budget);
	const inProgress = active.find((t) => t.status === "in_progress");
	if (inProgress && !visible.includes(inProgress)) visible[visible.length - 1] = inProgress;
	return { visible, hidden: active.length - visible.length };
}

function renderRow(todo: Todo, isLast: boolean, theme: Theme, width: number): string {
	const prefix = theme.fg("dim", isLast ? "└─" : "├─");
	const subject =
		todo.status === "completed" ? theme.fg("dim", todo.subject) : theme.fg("text", todo.subject);
	const active =
		todo.status === "in_progress" && todo.activeForm ? ` ${theme.fg("dim", `(${todo.activeForm})`)}` : "";
	return truncateToWidth(`${prefix} ${statusGlyph(todo.status, theme)} ${subject}${active}`, width, "…");
}

/**
 * Register, refresh, or remove the panel to match the primary session's list.
 *
 * Re-calling `setWidget` on every change (instead of mutating one long-lived
 * component) is deliberate: pi's `setWidget` disposes the old component,
 * rebuilds the widget layout, and repaints. Updating in place with
 * `requestRender()` skips that rebuild, which left the count stale. This is the
 * component-factory equivalent of cost-tracker re-setting a fresh string array.
 */
function refreshPanel(): void {
	if (!panelCtx) return;
	const hasActive = stateFor(primarySession).todos.some((t) => t.status !== "completed");

	if (!hasActive) {
		if (panelRegistered) {
			panelCtx.ui.setWidget(WIDGET_KEY, undefined);
			panelRegistered = false;
		}
		return;
	}

	panelCtx.ui.setWidget(
		WIDGET_KEY,
		(_tui, factoryTheme) => ({
			render: (width: number) =>
				renderPanel(stateFor(primarySession).todos, panelCtx?.ui.theme ?? factoryTheme, width),
			invalidate: () => {
				// No cached output; the next render reads the live state.
			},
		}),
		{ placement: "aboveEditor" },
	);
	panelRegistered = true;
}

function disposePanel(): void {
	if (panelRegistered && panelCtx) panelCtx.ui.setWidget(WIDGET_KEY, undefined);
	panelRegistered = false;
	panelCtx = undefined;
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function piTasks(pi: ExtensionAPI): void {
	const replayInto = (ctx: ExtensionContext | ExtensionCommandContext): TodoState => {
		const state = replayFromBranch(ctx);
		sessions.set(sid(ctx), state);
		return state;
	};

	pi.on("session_start", (_event, ctx) => {
		replayInto(ctx);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// First UI-bearing session claims the panel; later (child) sessions keep
		// their own state but never repaint it.
		if (primarySession === "") primarySession = sid(ctx);
		if (sid(ctx) !== primarySession) return;
		panelCtx = ctx;
		panelRegistered = false;
		refreshPanel();
	});

	pi.on("session_tree", (_event, ctx) => {
		replayInto(ctx);
		refreshPanel();
	});

	// Compaction summarizes the conversation away, including the tool results
	// that hold the task list. Re-inject a one-line reminder of the unfinished
	// tasks (hidden from the TUI) so the plan and its ids survive the boundary.
	pi.on("session_compact", (_event, ctx) => {
		const state = replayInto(ctx);
		refreshPanel();
		const reminder = formatCompactReminder(state);
		if (reminder) pi.sendMessage({ customType: REMINDER_TYPE, content: reminder, display: false });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = sid(ctx);
		sessions.delete(id);
		if (id === primarySession) {
			primarySession = "";
			disposePanel();
		}
	});

	// Enforcement — the prompt guidelines alone don't make every model keep the
	// list current, so we nudge. Both nudges are hidden (display:false) and only
	// fire for a plan the model engaged with in this run, so leftover tasks from
	// an earlier session never nag.

	pi.on("agent_start", () => {
		runTouchedTodos = false;
		runDidWork = false;
		runReconciled = false;
		lastNudgeSignature = "";
		lastNudgeTurn = -DRIFT_RESEND_TURNS;
	});

	// Drift nudge: a turn did real work but never touched the list. Deduped by
	// list signature and re-sent at most every DRIFT_RESEND_TURNS turns.
	pi.on("turn_end", (event, ctx) => {
		if (event.toolResults.some((r) => r.toolName !== TOOL_NAME)) runDidWork = true;
		if (!runTouchedTodos || !runDidWork) return;
		if (event.toolResults.some((r) => r.toolName === TOOL_NAME)) return;
		if (event.toolResults.length === 0) return;

		const state = stateFor(sid(ctx));
		const nudge = formatTaskNudge(state, "drift");
		if (!nudge) return;

		const signature = taskSignature(state);
		if (signature === lastNudgeSignature && event.turnIndex - lastNudgeTurn < DRIFT_RESEND_TURNS) {
			return;
		}
		lastNudgeSignature = signature;
		lastNudgeTurn = event.turnIndex;
		return { entries: [nudgeEntry(nudge)] };
	});

	// Settle enforcement: force exactly one reconciliation request before the run
	// ends with unfinished tasks. `runReconciled` guarantees no loop.
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed" || runReconciled) return;
		if (!runTouchedTodos || !runDidWork) return;

		const nudge = formatTaskNudge(stateFor(sid(ctx)), "settle");
		if (!nudge) return;

		runReconciled = true;
		return { entries: [nudgeEntry(nudge)], continue: true };
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		executionMode: "sequential",
		description:
			"Maintain a task list for multi-step work. Actions: create (new task from subject), update (change subject/status/activeForm by id), delete (remove by id), list (all tasks). Status is pending, in_progress, or completed. Keep exactly one task in_progress.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			runTouchedTodos = true;
			const id = sid(ctx);
			const result = applyTodoMutation(stateFor(id), params as TodoParams);
			sessions.set(id, result.state);
			if (id === primarySession) refreshPanel();

			const details: TodoDetails = { todos: result.state.todos, nextId: result.state.nextId };
			if (result.error) details.error = result.error;
			return {
				content: [{ type: "text", text: result.error ? `Error: ${result.error}` : result.text }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.subject) text += ` ${theme.fg("dim", `"${args.subject}"`)}`;
			if (args.status) text += ` ${theme.fg("muted", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			if (details && expanded) {
				return new Text(
					details.todos
						.map((t) => `${statusGlyph(t.status, theme)} ${theme.fg("dim", `#${t.id}`)} ${t.subject}`)
						.join("\n"),
					0,
					0,
				);
			}
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show the current task list",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const todos = stateFor(sid(ctx)).todos;
			if (todos.length === 0) {
				ctx.ui.notify("No tasks yet. Ask the agent to add some!", "info");
				return;
			}
			const done = todos.filter((t) => t.status === "completed").length;
			const groups: Array<{ label: string; statuses: TodoStatus[] }> = [
				{ label: "Pending", statuses: ["pending"] },
				{ label: "In Progress", statuses: ["in_progress"] },
				{ label: "Completed", statuses: ["completed"] },
			];
			const lines = [`${done}/${todos.length} completed`];
			for (const { label, statuses } of groups) {
				const group = todos.filter((t) => statuses.includes(t.status));
				if (group.length === 0) continue;
				lines.push(`── ${label} ──`);
				for (const t of group) {
					const active = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
					lines.push(`${statusGlyph(t.status, ctx.ui.theme)} #${t.id} ${t.subject}${active}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
