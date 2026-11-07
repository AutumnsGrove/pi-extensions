import { describe, expect, it } from "vitest";
import { editSettings, type PanelUI } from "./panel.ts";
import { defaultSettings } from "./settings.ts";

type Answer = string | undefined;

function scripted(script: {
	select?: Answer[];
	input?: Answer[];
	confirm?: boolean[];
}): PanelUI & { notifications: string[]; prompts: string[] } {
	const selects = [...(script.select ?? [])];
	const inputs = [...(script.input ?? [])];
	const confirms = [...(script.confirm ?? [])];
	const notifications: string[] = [];
	const prompts: string[] = [];
	const take = <T>(queue: T[], kind: string): T => {
		if (queue.length === 0) throw new Error(`no scripted ${kind} left`);
		return queue.shift()!;
	};
	return {
		notifications,
		prompts,
		async select(title) {
			prompts.push(title);
			return take(selects, "select") as unknown as string | undefined;
		},
		async input(title) {
			prompts.push(title);
			return take(inputs, "input") as unknown as string | undefined;
		},
		async confirm(title) {
			prompts.push(title);
			return take(confirms, "confirm") as unknown as boolean;
		},
		notify(message) {
			notifications.push(message);
		},
	};
}

const base = defaultSettings({ provider: "opencode-go", model: "m", piVersion: "1.5.0", packageRef: "abc" });

describe("editSettings", () => {
	it("saves without changes", async () => {
		const result = await editSettings(base, scripted({ select: ["Save and continue"] }));
		expect(result).toEqual(base);
	});

	it("edits the model and thinking", async () => {
		const ui = scripted({
			select: ["Model: m", "Thinking: medium", "high", "Save and continue"],
			input: ["provider/new-model"],
		});
		const result = await editSettings(base, ui);
		expect(result).toMatchObject({ model: "provider/new-model", thinking: "high" });
	});

	it("turns bash off and disables dependency install", async () => {
		const start = structuredClone(base);
		start.tools.bash = true;
		start.verify.installDependencies = true;
		const ui = scripted({
			select: ["Tools: read + bash", "Read-only (read, grep, find, ls)", "Save and continue"],
		});
		const result = await editSettings(start, ui);
		expect(result).toMatchObject({ tools: { bash: false }, verify: { installDependencies: false } });
	});

	it("edits strictness, verdict, threads, and mention", async () => {
		const ui = scripted({
			select: [
				"Strictness: significant — merge-blocking findings only",
				"balanced — plus design and test gaps",
				"Verdict: COMMENT",
				"REQUEST_CHANGES — request changes",
				"Resolve stale threads: no",
				"Yes",
				"Mention trigger: on",
				"Off",
				"Save and continue",
			],
		});
		const result = await editSettings(base, ui);
		expect(result).toMatchObject({
			review: { strictness: "balanced", event: "REQUEST_CHANGES", resolveStaleThreads: true },
			triggers: { mention: false },
		});
	});

	it("warns when dependency install is chosen without bash", async () => {
		const ui = scripted({
			select: ["Install dependencies: no", "Save and continue"],
		});
		const result = await editSettings(base, ui);
		expect(result).toEqual(base);
		expect(ui.notifications.join("\n")).toContain("Enable bash under Tools first");
	});

	it("returns the raw-json sentinel", async () => {
		expect(await editSettings(base, scripted({ select: ["Edit raw JSON…"] }))).toBe("json");
	});

	it("returns undefined on cancel or escape", async () => {
		expect(await editSettings(base, scripted({ select: ["Cancel"] }))).toBeUndefined();
		expect(await editSettings(base, scripted({ select: [undefined] }))).toBeUndefined();
	});

	it("keeps the previous value when a sub-dialog is cancelled", async () => {
		const ui = scripted({ select: ["Thinking: medium", undefined, "Save and continue"] });
		const result = await editSettings(base, ui);
		expect(result).toEqual(base);
	});
});
