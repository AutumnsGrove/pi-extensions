import { describe, expect, it } from "vitest";
import {
	applyTodoMutation,
	emptyState,
	formatCompactReminder,
	formatTodoLine,
	isTodoDetails,
	replayFromBranch,
	type Todo,
	type TodoState,
} from "./state.ts";

const todo = (id: number, subject: string, status: Todo["status"] = "pending", activeForm?: string): Todo => ({
	id,
	subject,
	status,
	...(activeForm ? { activeForm } : {}),
});

describe("applyTodoMutation — create", () => {
	it("appends a pending task with the next id and trims the subject", () => {
		const result = applyTodoMutation(emptyState(), { action: "create", subject: "  Write parser  " });
		expect(result.error).toBeUndefined();
		expect(result.state.todos).toEqual([todo(1, "Write parser")]);
		expect(result.state.nextId).toBe(2);
		expect(result.text).toBe("Created #1: Write parser (pending)");
	});

	it("keeps the activeForm when supplied", () => {
		const result = applyTodoMutation(emptyState(), {
			action: "create",
			subject: "Write parser",
			activeForm: "writing the parser",
		});
		expect(result.state.todos[0]?.activeForm).toBe("writing the parser");
	});

	it("rejects a blank subject without changing state", () => {
		const state = { todos: [todo(1, "Existing")], nextId: 2 };
		const result = applyTodoMutation(state, { action: "create", subject: "   " });
		expect(result.error).toBe("subject required for create");
		expect(result.state).toBe(state);
	});
});

describe("applyTodoMutation — update", () => {
	it("changes status and reports the transition", () => {
		const state: TodoState = { todos: [todo(1, "Write parser")], nextId: 2 };
		const result = applyTodoMutation(state, { action: "update", id: 1, status: "in_progress" });
		expect(result.error).toBeUndefined();
		expect(result.state.todos[0]?.status).toBe("in_progress");
		expect(result.text).toBe("Updated #1 (pending → in_progress)");
	});

	it("refines the subject and sets an activeForm", () => {
		const state: TodoState = { todos: [todo(1, "Write parser", "in_progress")], nextId: 2 };
		const result = applyTodoMutation(state, {
			action: "update",
			id: 1,
			subject: "Write tokenizer",
			activeForm: "writing the tokenizer",
		});
		expect(result.state.todos[0]).toMatchObject({
			subject: "Write tokenizer",
			activeForm: "writing the tokenizer",
		});
		expect(result.text).toBe("Updated #1");
	});

	it("clears the activeForm with an empty string", () => {
		const state: TodoState = { todos: [todo(1, "Write parser", "in_progress", "writing")], nextId: 2 };
		const result = applyTodoMutation(state, { action: "update", id: 1, activeForm: "" });
		expect(result.state.todos[0]?.activeForm).toBeUndefined();
	});

	it("rejects an update with no mutable field", () => {
		const state: TodoState = { todos: [todo(1, "Write parser")], nextId: 2 };
		expect(applyTodoMutation(state, { action: "update", id: 1 }).error).toBe(
			"update requires at least one of subject, status, activeForm",
		);
	});

	it("rejects an unknown id", () => {
		expect(applyTodoMutation(emptyState(), { action: "update", id: 9, status: "completed" }).error).toBe(
			"#9 not found",
		);
	});

	it("rejects a blank subject", () => {
		const state: TodoState = { todos: [todo(1, "Write parser")], nextId: 2 };
		expect(applyTodoMutation(state, { action: "update", id: 1, subject: " " }).error).toBe(
			"subject cannot be empty",
		);
	});
});

describe("applyTodoMutation — delete", () => {
	it("removes the task and keeps ids monotonic", () => {
		const state: TodoState = { todos: [todo(1, "A"), todo(2, "B")], nextId: 3 };
		const result = applyTodoMutation(state, { action: "delete", id: 1 });
		expect(result.state.todos).toEqual([todo(2, "B")]);
		expect(result.state.nextId).toBe(3);
		expect(result.text).toBe("Deleted #1: A");
	});

	it("rejects an unknown id", () => {
		expect(applyTodoMutation(emptyState(), { action: "delete", id: 9 }).error).toBe("#9 not found");
	});
});

describe("applyTodoMutation — list", () => {
	it("formats every task and does not mutate state", () => {
		const state: TodoState = {
			todos: [todo(1, "Done", "completed"), todo(2, "Active", "in_progress", "working")],
			nextId: 3,
		};
		const result = applyTodoMutation(state, { action: "list" });
		expect(result.state).toBe(state);
		expect(result.text).toBe("[completed] #1 Done\n[in_progress] #2 Active (working)");
	});

	it("reports an empty list", () => {
		expect(applyTodoMutation(emptyState(), { action: "list" }).text).toBe("No todos");
	});
});

describe("formatTodoLine", () => {
	it("only shows an activeForm while in_progress", () => {
		expect(formatTodoLine(todo(1, "A", "pending", "ignored"))).toBe("[pending] #1 A");
		expect(formatTodoLine(todo(2, "B", "in_progress", "working"))).toBe("[in_progress] #2 B (working)");
	});
});

describe("formatCompactReminder", () => {
	it("returns undefined with nothing unfinished", () => {
		expect(formatCompactReminder(emptyState())).toBeUndefined();
		expect(formatCompactReminder({ todos: [todo(1, "Done", "completed")], nextId: 2 })).toBeUndefined();
	});

	it("summarizes unfinished tasks with ids, status, and the activeForm", () => {
		const state: TodoState = {
			todos: [todo(1, "Done", "completed"), todo(2, "Active", "in_progress", "working"), todo(3, "Next")],
			nextId: 4,
		};
		expect(formatCompactReminder(state)).toBe(
			"Task list (1/3 done): #2 [in_progress] Active (working); #3 [pending] Next. Keep updating it with the todo tool.",
		);
	});

	it("caps the list and notes the remainder", () => {
		const todos = Array.from({ length: 11 }, (_, i) => todo(i + 1, `Task ${i + 1}`));
		const reminder = formatCompactReminder({ todos, nextId: 12 });
		expect(reminder).toContain("+3 more");
		expect(reminder).toContain("#8 [pending] Task 8");
		expect(reminder).not.toContain("#9");
	});
});

describe("isTodoDetails", () => {
	it("accepts a snapshot and rejects other shapes", () => {
		expect(isTodoDetails({ todos: [], nextId: 1 })).toBe(true);
		expect(isTodoDetails({ tasks: [], nextId: 1 })).toBe(false);
		expect(isTodoDetails(null)).toBe(false);
		expect(isTodoDetails({ todos: [] })).toBe(false);
	});
});

describe("replayFromBranch", () => {
	const wrap = (details: unknown, toolName = "todo") => ({
		type: "message",
		message: { role: "toolResult", toolName, details },
	});

	it("returns the last todo snapshot on the branch", () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					wrap({ todos: [todo(1, "First")], nextId: 2 }),
					{ type: "message", message: { role: "assistant" } },
					wrap({ todos: [todo(1, "First", "completed"), todo(2, "Second")], nextId: 3 }),
				],
			},
		};
		expect(replayFromBranch(ctx)).toEqual({
			todos: [todo(1, "First", "completed"), todo(2, "Second")],
			nextId: 3,
		});
	});

	it("ignores other tools and malformed details", () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					wrap({ todos: [todo(1, "Other")], nextId: 2 }, "not-todo"),
					wrap({ tasks: [], nextId: 1 }),
				],
			},
		};
		expect(replayFromBranch(ctx)).toEqual(emptyState());
	});

	it("returns a fresh empty state with no matching entry", () => {
		const ctx = { sessionManager: { getBranch: () => [] } };
		expect(replayFromBranch(ctx)).toEqual({ todos: [], nextId: 1 });
	});
});
