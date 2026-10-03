import { beforeAll, describe, expect, it } from "vitest";
import {
	AssistantMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThinkingBoxState, installThinkingBox } from "./patch.ts";
import { messageKey, STATS_ENTRY_TYPE } from "./stats.ts";

beforeAll(() => {
	initTheme("dark", false);
});

function assistantMessage(thinking: string, timestamp = 1_000) {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			reasoning: 4_200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as unknown as NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
}

describe("thinking-box prototype patch", () => {
	it("exports the live component and patches it once", () => {
		installThinkingBox();
		installThinkingBox();
		const proto = AssistantMessageComponent.prototype as unknown as {
			__tb_installed?: boolean;
			setExpanded?: unknown;
		};
		expect(proto.__tb_installed).toBe(true);
		expect(typeof proto.setExpanded).toBe("function");
	});

	it("renders a collapsed box with a timed header and a clipped preview", () => {
		const state = getThinkingBoxState();
		state.enabled = true;
		state.expanded = false;
		state.previewLines = 2;
		state.theme = undefined;

		const message = assistantMessage(
			"alpha line one\nbeta line two\ngamma line three\ndelta line four"
		);
		const component = new AssistantMessageComponent(message);
		component.updateContent(message, true);

		const lines = component.render(72);
		const text = lines.join("\n");

		expect(text).toContain("Thinking");
		expect(text).toContain("4.2k tokens");
		expect(text).toContain("ctrl+o to expand");
		expect(text).toContain("─");

		// Collapsed preview keeps the last two visual lines only.
		expect(text).toContain("gamma line three");
		expect(text).toContain("delta line four");
		expect(text).not.toContain("alpha line one");
	});

	it("shows elapsed thinking time across streaming updates", async () => {
		const state = getThinkingBoxState();
		state.enabled = true;
		state.expanded = false;
		state.previewLines = 2;
		state.theme = undefined;

		const first = assistantMessage("first token", 5_000);
		const component = new AssistantMessageComponent(first);
		component.updateContent(first, true);

		await new Promise((resolve) => setTimeout(resolve, 15));

		const later = assistantMessage("first token and more", 5_000);
		component.updateContent(later, true);

		const text = component.render(72).join("\n");
		expect(text).toContain("Thinking for");
	});

	it("expands to the full trace and drops the hint", () => {
		const state = getThinkingBoxState();
		state.enabled = true;
		state.expanded = false;
		state.previewLines = 1;
		state.theme = undefined;

		const message = assistantMessage(
			"alpha line one\nbeta line two\ngamma line three",
			2_000
		);
		const component = new AssistantMessageComponent(message);
		component.updateContent(message, true);

		(component as unknown as { setExpanded: (v: boolean) => void }).setExpanded(
			true
		);
		const text = component.render(72).join("\n");

		expect(text).toContain("alpha line one");
		expect(text).toContain("gamma line three");
		expect(text).not.toContain("ctrl+o to expand");
	});

	it("never renders a line wider than the terminal width", () => {
		const state = getThinkingBoxState();
		state.enabled = true;
		state.expanded = false;
		state.previewLines = 2;
		state.theme = undefined;

		const message = assistantMessage(
			"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
		);
		const component = new AssistantMessageComponent(message);
		component.updateContent(message, true);

		// Strip OSC-133 zone markers before measuring; they carry no width.
		const stripOsc = (line: string) => line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

		for (const width of [1, 2, 9, 20, 40, 80]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(stripOsc(line))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("uses the stored key shape for persisted stats", () => {
		const message = assistantMessage("x", 3_000);
		expect(messageKey(message)).toBe("3000");
		expect(STATS_ENTRY_TYPE).toBe("thinking-stats");
	});
});
