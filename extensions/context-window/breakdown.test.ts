import { describe, expect, it } from "vitest";
import { analyzeContext, breakdownRows, type ContextMessage } from "./breakdown.ts";

const message = (value: unknown): ContextMessage => value as ContextMessage;

describe("analyzeContext", () => {
	it("attributes estimated tokens to each role and block", () => {
		const messages: ContextMessage[] = [
			message({ role: "system", content: "hello" }), // 5 chars -> 2
			message({ role: "user", content: "12345678" }), // 8 -> 2
			message({
				role: "assistant",
				content: [
					{ type: "text", text: "abcd" }, // 4 -> 1
					{ type: "thinking", thinking: "abcdefgh" }, // 8 -> 2
					{ type: "toolCall", name: "read", arguments: { path: "x" } }, // 4 + 12 -> 4
				],
			}),
			message({ role: "toolResult", content: [{ type: "text", text: "12345678" }] }), // 8 -> 2
			message({ role: "compactionSummary", summary: "abcdefgh" }), // 8 -> 2
			message({ role: "bashExecution", command: "ls", output: "abcd" }), // 6 -> 2
			message({ role: "custom", content: "1234" }), // 4 -> 1
		];

		const breakdown = analyzeContext(messages);
		expect(breakdown.system).toBe(2);
		expect(breakdown.user).toBe(2);
		expect(breakdown.assistantText).toBe(1);
		expect(breakdown.assistantThinking).toBe(2);
		expect(breakdown.toolCalls).toBe(4);
		expect(breakdown.toolResults).toBe(2);
		expect(breakdown.summary).toBe(2);
		expect(breakdown.bash).toBe(2);
		expect(breakdown.custom).toBe(1);
		expect(breakdown.other).toBe(0);
		expect(breakdown.total).toBe(18);
		expect(breakdown.images).toBe(0);
	});

	it("counts images and includes their estimate in the role", () => {
		const messages: ContextMessage[] = [
			message({
				role: "user",
				content: [
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "1234" },
				],
			}),
		];
		const breakdown = analyzeContext(messages);
		// 4800 image chars + 4 text chars = 4804 -> 1201
		expect(breakdown.user).toBe(1201);
		expect(breakdown.images).toBe(1);
	});

	it("handles string content", () => {
		const breakdown = analyzeContext([message({ role: "user", content: "1234" })]);
		expect(breakdown.user).toBe(1);
		expect(breakdown.other).toBe(0);
	});
});

describe("breakdownRows", () => {
	it("omits empty categories and keeps a readable order", () => {
		const breakdown = analyzeContext([
			message({ role: "system", content: "1234" }),
			message({ role: "toolResult", content: [{ type: "text", text: "12345678" }] }),
		]);
		const labels = breakdownRows(breakdown).map((row) => row.label);
		expect(labels).toEqual(["System prompt", "Tool results"]);
	});
});
