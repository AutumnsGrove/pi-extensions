import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	MIN_RECOVERY_CHARS,
	assistantText,
	classifySettlement,
	isSubstantiveReview,
	recoverySummary,
} from "./failure.ts";

function message(
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"] = [],
	errorMessage?: string
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
	} as AssistantMessage;
}

describe("classifySettlement", () => {
	it("calls a normal prose ending incomplete", () => {
		expect(classifySettlement(message("stop"))).toMatchObject({
			kind: "incomplete",
			retryable: false,
		});
		expect(classifySettlement(undefined).kind).toBe("incomplete");
	});

	it("recognises a transient provider error", () => {
		expect(
			classifySettlement(message("error", [], "429: the inference service is overloaded"))
		).toMatchObject({
			kind: "provider",
			retryable: true,
			detail: "429: the inference service is overloaded",
		});
	});

	it("keeps a quota or billing error non-retryable", () => {
		expect(
			classifySettlement(message("error", [], "insufficient_quota: check your plan"))
		).toMatchObject({
			kind: "provider",
			retryable: false,
		});
	});

	it("separates aborts and output limits", () => {
		expect(classifySettlement(message("aborted")).kind).toBe("aborted");
		expect(classifySettlement(message("length")).kind).toBe("budget");
	});
});

describe("recovery helpers", () => {
	it("takes only text content from the final assistant message", () => {
		const text = assistantText(
			message("stop", [
				{ type: "thinking", thinking: "private" } as never,
				{ type: "text", text: "  The review.  " },
			])
		);
		expect(text).toBe("The review.");
	});

	it("requires a substantive answer", () => {
		expect(isSubstantiveReview("short")).toBe(false);
		expect(isSubstantiveReview("x".repeat(MIN_RECOVERY_CHARS - 1))).toBe(false);
		expect(isSubstantiveReview("x".repeat(MIN_RECOVERY_CHARS))).toBe(true);
	});

	it("labels a recovered review honestly", () => {
		const summary = recoverySummary("The review body.");
		expect(summary).toContain("Submitted by recovery");
		expect(summary).toContain("COMMENT review");
		expect(summary.endsWith("The review body.")).toBe(true);
	});
});
