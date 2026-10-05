/**
 * Pure todo state: types, reducer, and branch replay.
 *
 * No pi imports live here so the whole module is trivially unit-testable. The
 * reducer is `(state, params) -> (state, text | error)`; the caller commits the
 * new state and persists it in the tool result's `details`.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
	id: number;
	subject: string;
	status: TodoStatus;
	/** Present-continuous label shown while `in_progress`, e.g. "writing tests". */
	activeForm?: string;
}

export interface TodoState {
	todos: Todo[];
	nextId: number;
}

/**
 * Persistence + replay snapshot. Every `todo` call returns this under
 * `details`; replay reads the latest one from the branch.
 */
export interface TodoDetails {
	todos: Todo[];
	nextId: number;
	error?: string;
}

export interface TodoParams {
	action: "create" | "update" | "delete" | "list";
	subject?: string;
	id?: number;
	status?: TodoStatus;
	activeForm?: string;
}

export interface MutationResult {
	state: TodoState;
	/** Model-facing confirmation line. Empty when `error` is set. */
	text: string;
	error?: string;
}

export const EMPTY_STATE: TodoState = { todos: [], nextId: 1 };

/** Fresh, non-aliasing copy so callers never share the module constant. */
export function emptyState(): TodoState {
	return { todos: [], nextId: EMPTY_STATE.nextId };
}

const fail = (state: TodoState, error: string): MutationResult => ({ state, text: "", error });

/**
 * Apply one action. Never throws: validation failures come back as `error` and
 * leave the state untouched, so callers can persist the same snapshot safely.
 *
 * Status transitions are intentionally unrestricted (pending ⇄ in_progress ⇄
 * completed). The model owns the plan; a strict state machine only adds error
 * surface for a primitive this small.
 */
export function applyTodoMutation(state: TodoState, params: TodoParams): MutationResult {
	switch (params.action) {
		case "create": {
			const subject = params.subject?.trim();
			if (!subject) return fail(state, "subject required for create");
			const todo: Todo = { id: state.nextId, subject, status: "pending" };
			if (params.activeForm?.trim()) todo.activeForm = params.activeForm.trim();
			return {
				state: { todos: [...state.todos, todo], nextId: state.nextId + 1 },
				text: `Created #${todo.id}: ${todo.subject} (pending)`,
			};
		}

		case "update": {
			if (params.id === undefined) return fail(state, "id required for update");
			const index = state.todos.findIndex((t) => t.id === params.id);
			if (index === -1) return fail(state, `#${params.id} not found`);

			const changesAny =
				params.subject !== undefined || params.status !== undefined || params.activeForm !== undefined;
			if (!changesAny) {
				return fail(state, "update requires at least one of subject, status, activeForm");
			}

			const current = state.todos[index]!;
			const updated: Todo = { ...current };
			if (params.subject !== undefined) {
				const subject = params.subject.trim();
				if (!subject) return fail(state, "subject cannot be empty");
				updated.subject = subject;
			}
			if (params.status !== undefined) updated.status = params.status;
			if (params.activeForm !== undefined) {
				// An empty string clears the label.
				if (params.activeForm.trim()) updated.activeForm = params.activeForm.trim();
				else delete updated.activeForm;
			}

			const todos = [...state.todos];
			todos[index] = updated;
			const transition =
				current.status !== updated.status ? ` (${current.status} → ${updated.status})` : "";
			return { state: { todos, nextId: state.nextId }, text: `Updated #${updated.id}${transition}` };
		}

		case "delete": {
			if (params.id === undefined) return fail(state, "id required for delete");
			const todo = state.todos.find((t) => t.id === params.id);
			if (!todo) return fail(state, `#${params.id} not found`);
			return {
				state: { todos: state.todos.filter((t) => t.id !== params.id), nextId: state.nextId },
				text: `Deleted #${todo.id}: ${todo.subject}`,
			};
		}

		case "list": {
			const text =
				state.todos.length === 0
					? "No todos"
					: state.todos.map(formatTodoLine).join("\n");
			return { state, text };
		}
	}
}

/** One `#id [status] subject (activeForm)` line, used by `list` output. */
export function formatTodoLine(todo: Todo): string {
	const active = todo.status === "in_progress" && todo.activeForm ? ` (${todo.activeForm})` : "";
	return `[${todo.status}] #${todo.id} ${todo.subject}${active}`;
}

const REMINDER_MAX_TASKS = 8;

/**
 * `Task list (done/total done): #2 [in_progress] X; #3 [pending] Y`, or
 * undefined when nothing is unfinished. Shared by the compaction reminder and
 * the drift/settle nudges.
 */
function formatTaskSummary(state: TodoState): string | undefined {
	const active = state.todos.filter((t) => t.status !== "completed");
	if (active.length === 0) return undefined;

	const done = state.todos.length - active.length;
	const parts = active.slice(0, REMINDER_MAX_TASKS).map((t) => {
		const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
		return `#${t.id} [${t.status}] ${t.subject}${form}`;
	});
	const rest = active.length - REMINDER_MAX_TASKS;
	if (rest > 0) parts.push(`+${rest} more`);
	return `Task list (${done}/${state.todos.length} done): ${parts.join("; ")}`;
}

/**
 * One-line task summary injected back into the model's context after a
 * compaction, so the plan, its ids, and the in-progress label survive the
 * summarization boundary. Returns undefined when nothing is unfinished.
 */
export function formatCompactReminder(state: TodoState): string | undefined {
	const summary = formatTaskSummary(state);
	return summary ? `${summary}. Keep updating it with the todo tool.` : undefined;
}

/**
 * Nudge injected when the model drifts from the list ("drift") or is about to
 * finish with unfinished tasks ("settle"). `settle` is deliberately more
 * directive because it accompanies one forced reconciliation request.
 */
export function formatTaskNudge(state: TodoState, phase: "drift" | "settle"): string | undefined {
	const summary = formatTaskSummary(state);
	if (!summary) return undefined;
	if (phase === "settle") {
		return `${summary}. You are about to finish with unfinished tasks. Before stopping, call the todo tool to mark finished work completed and move the next task to in_progress, or tell the user exactly what remains.`;
	}
	return `${summary}. This list is stale — update it with the todo tool as you work: mark the current task in_progress, and completed as soon as it is done.`;
}

/** Shape check for defensive branch replay. */
export function isTodoDetails(value: unknown): value is TodoDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.todos) && typeof v.nextId === "number";
}

/**
 * Walk the branch chronologically; the last `todo` tool result's snapshot wins.
 * Pure of module state — the caller writes the result into the session slot.
 */
export function replayFromBranch(ctx: {
	sessionManager: { getBranch(): Iterable<unknown> };
}): TodoState {
	let result = emptyState();
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTodoDetails(msg.details)) continue;
		result = { todos: msg.details.todos.map((t) => ({ ...t })), nextId: msg.details.nextId };
	}
	return result;
}
