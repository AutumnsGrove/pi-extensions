import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createDispatchState,
	dispatchHooks,
	mergeResults,
	selectHooks,
} from "./dispatch.ts";
import type { HookInput, HookRunResult, NormalizedHook } from "./types.ts";

const ctx = {} as ExtensionContext;

function input(overrides: Partial<HookInput> = {}): HookInput {
	return {
		session_id: "session-1",
		transcript_path: null,
		cwd: process.cwd(),
		hook_event_name: "PreToolUse",
		tool_name: "bash",
		tool_input: { command: "git status" },
		tool_use_id: "call-1",
		...overrides,
	};
}

function hook(
	handler: NormalizedHook["handler"],
	overrides: Partial<NormalizedHook> = {},
): NormalizedHook {
	return {
		event: "PreToolUse",
		matcher: undefined,
		handler,
		key: `key-${Math.random()}`,
		source: "test",
		...overrides,
	};
}

function result(output: HookRunResult["output"], error?: string): HookRunResult {
	return {
		hook: hook({ type: "command", command: "x" }),
		output,
		applied: output !== null,
		durationMs: 1,
		error,
	};
}

describe("mergeResults", () => {
	it("ranks deny over ask over allow", () => {
		expect(
			mergeResults("PreToolUse", [
				result({ decision: "allow" }),
				result({ decision: "ask", reason: "check" }),
				result({ decision: "deny", reason: "no" }),
			]).decision,
		).toBe("deny");
		expect(
			mergeResults("PreToolUse", [
				result({ decision: "allow" }),
				result({ decision: "ask", reason: "check" }),
			]),
		).toMatchObject({ decision: "ask", reason: "check" });
	});

	it("merges updated input in order and accumulates context", () => {
		const merged = mergeResults("PreToolUse", [
			result({ updatedInput: { command: "ls" }, additionalContext: "one" }),
			result({ updatedInput: { timeout: 5 }, additionalContext: "two" }),
			result({ additionalContext: "one" }),
		]);
		expect(merged.updatedInput).toEqual({ command: "ls", timeout: 5 });
		expect(merged.additionalContext).toEqual(["one", "two"]);
	});

	it("lets continue:false stop the run", () => {
		const merged = mergeResults("PreToolUse", [
			result({ continue: false, stopReason: "halt" }),
			result({ decision: "allow" }),
		]);
		expect(merged.stop).toBe(true);
		expect(merged.stopReason).toBe("halt");
	});

	it("collects errors without failing dispatch", () => {
		const merged = mergeResults("PreToolUse", [result(null, "boom")]);
		expect(merged.errors).toHaveLength(1);
		expect(merged.decision).toBeUndefined();
	});
});

describe("selectHooks", () => {
	it("filters by event, matcher, and if-rule", () => {
		const hooks = [
			hook({ type: "command", command: "a" }),
			hook({ type: "command", command: "b" }, { matcher: "write" }),
			hook({ type: "command", command: "c", if: "bash(git *)" }),
			hook({ type: "command", command: "d", if: "bash(rm *)" }),
			hook({ type: "command", command: "e" }, { event: "PostToolUse" }),
		];
		const selected = selectHooks("PreToolUse", input(), hooks);
		expect(
			selected.map((entry) => (entry.handler as { command?: string }).command),
		).toEqual(["a", "c"]);
	});

	it("skips a once hook after it ran", () => {
		const state = createDispatchState();
		const once = hook({ type: "command", command: "a", once: true });
		expect(selectHooks("PreToolUse", input(), [once], state)).toHaveLength(1);
		state.once.add(once.key);
		expect(selectHooks("PreToolUse", input(), [once], state)).toHaveLength(0);
	});
});

describe("dispatchHooks with command handlers", () => {
	it("applies JSON output from exit 0", async () => {
		const script = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const e=JSON.parse(d);process.stdout.write(JSON.stringify({decision:e.tool_input.command==="git status"?"allow":"deny",reason:"checked"}))})`;
		const hooks = [
			hook({ type: "command", command: process.execPath, args: ["-e", script] }),
		];
		const outcome = await dispatchHooks("PreToolUse", input(), ctx, hooks);
		expect(outcome.decision).toBe("allow");
	});

	it("blocks on exit code 2 and uses stderr as the reason", async () => {
		const hooks = [
			hook({
				type: "command",
				command: process.execPath,
				args: ["-e", "process.stderr.write('no rm -rf');process.exit(2)"],
			}),
		];
		const outcome = await dispatchHooks("PreToolUse", input(), ctx, hooks);
		expect(outcome.decision).toBe("deny");
		expect(outcome.reason).toBe("no rm -rf");
	});

	it("treats a timeout as an error, and as a deny with onFailure:block", async () => {
		const slow = {
			type: "command" as const,
			command: process.execPath,
			args: ["-e", "setTimeout(()=>{},5000)"],
			timeout: 0.05,
			onFailure: "block" as const,
		};
		const outcome = await dispatchHooks("PreToolUse", input(), ctx, [hook(slow)]);
		expect(outcome.decision).toBe("deny");
		expect(outcome.errors[0]).toContain("timed out");
	});

	it("does not block on a non-zero exit by default", async () => {
		const hooks = [
			hook({
				type: "command",
				command: process.execPath,
				args: ["-e", "process.exit(1)"],
			}),
		];
		const outcome = await dispatchHooks("PreToolUse", input(), ctx, hooks);
		expect(outcome.decision).toBeUndefined();
		expect(outcome.errors).toHaveLength(1);
	});
});

describe("in-process bus", () => {
	it("merges a handler's output", async () => {
		const outcome = await dispatchHooks("PreToolUse", input(), ctx, [], {
			bus: [
				{
					event: "PreToolUse",
					handler: () => ({ decision: "deny", reason: "bus says no" }),
					source: "test-extension",
				},
			],
		});
		expect(outcome.decision).toBe("deny");
		expect(outcome.reason).toBe("bus says no");
	});

	it("respects a bus matcher", async () => {
		const outcome = await dispatchHooks("PreToolUse", input(), ctx, [], {
			bus: [
				{
					event: "PreToolUse",
					matcher: "write",
					handler: () => ({ decision: "deny" }),
					source: "test-extension",
				},
			],
		});
		expect(outcome.decision).toBeUndefined();
	});
});
