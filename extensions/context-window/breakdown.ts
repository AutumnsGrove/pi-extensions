/**
 * Token breakdown of the model-visible context.
 *
 * The total comes from pi's own usage accounting (`ctx.getContextUsage()`);
 * this walks the canonical session projection and attributes estimated tokens
 * to categories so `/context` can show where the space goes. Estimates use the
 * same chars/4 heuristic as pi's compaction code, so they track totals closely
 * without being exact.
 */

import { estimateTokens, type SessionProjection } from "@earendil-works/pi-coding-agent";

export type ContextMessage = SessionProjection["messages"][number];

export interface ContextBreakdown {
	system: number;
	summary: number;
	user: number;
	assistantText: number;
	assistantThinking: number;
	toolCalls: number;
	toolResults: number;
	bash: number;
	custom: number;
	other: number;
	total: number;
	/** Image blocks seen, already included in their role's token estimate. */
	images: number;
}

function toTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function countImages(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}
	let count = 0;
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "image") {
			count += 1;
		}
	}
	return count;
}

/** Attribute estimated tokens across the model-visible messages. */
export function analyzeContext(messages: readonly ContextMessage[]): ContextBreakdown {
	const breakdown: ContextBreakdown = {
		system: 0,
		summary: 0,
		user: 0,
		assistantText: 0,
		assistantThinking: 0,
		toolCalls: 0,
		toolResults: 0,
		bash: 0,
		custom: 0,
		other: 0,
		total: 0,
		images: 0,
	};

	let textChars = 0;
	let thinkingChars = 0;
	let toolCallChars = 0;

	for (const message of messages) {
		switch (message.role) {
			case "system":
				breakdown.system += estimateTokens(message);
				break;
			case "user":
				breakdown.user += estimateTokens(message);
				breakdown.images += countImages(message.content);
				break;
			case "assistant": {
				for (const block of message.content) {
					if (block.type === "text") {
						textChars += block.text.length;
					} else if (block.type === "thinking") {
						thinkingChars += block.thinking.length;
					} else if (block.type === "toolCall") {
						toolCallChars += block.name.length + JSON.stringify(block.arguments).length;
					}
				}
				break;
			}
			case "toolResult":
				breakdown.toolResults += estimateTokens(message);
				breakdown.images += countImages(message.content);
				break;
			case "bashExecution":
				breakdown.bash += estimateTokens(message);
				break;
			case "custom":
				breakdown.custom += estimateTokens(message);
				breakdown.images += countImages(message.content);
				break;
			case "branchSummary":
			case "compactionSummary":
				breakdown.summary += estimateTokens(message);
				break;
			default:
				breakdown.other += estimateTokens(message);
				break;
		}
	}

	breakdown.assistantText = toTokens(textChars);
	breakdown.assistantThinking = toTokens(thinkingChars);
	breakdown.toolCalls = toTokens(toolCallChars);

	breakdown.total =
		breakdown.system +
		breakdown.summary +
		breakdown.user +
		breakdown.assistantText +
		breakdown.assistantThinking +
		breakdown.toolCalls +
		breakdown.toolResults +
		breakdown.bash +
		breakdown.custom +
		breakdown.other;

	return breakdown;
}

/** Ordered rows for rendering, omitting empty categories. */
export function breakdownRows(
	breakdown: ContextBreakdown
): Array<{ label: string; tokens: number }> {
	const rows: Array<{ label: string; tokens: number }> = [
		{ label: "System prompt", tokens: breakdown.system },
		{ label: "Summaries", tokens: breakdown.summary },
		{ label: "User messages", tokens: breakdown.user },
		{ label: "Assistant text", tokens: breakdown.assistantText },
		{ label: "Thinking", tokens: breakdown.assistantThinking },
		{ label: "Tool calls", tokens: breakdown.toolCalls },
		{ label: "Tool results", tokens: breakdown.toolResults },
		{ label: "Shell output", tokens: breakdown.bash },
		{ label: "Custom messages", tokens: breakdown.custom },
		{ label: "Other", tokens: breakdown.other },
	];
	return rows.filter((row) => row.tokens > 0);
}
