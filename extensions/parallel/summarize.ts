import { uuidv7 } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { clipPages, type PageContent } from "./format.ts";

export interface SummarizeInput {
	ctx: ExtensionToolContext;
	prompt: string;
	pages: PageContent[];
	model?: Model<Api>;
	maxChars: number;
}

export interface SummarizeOutput {
	text: string;
	usage?: Usage;
	modelLabel: string;
}

const escapeAttribute = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pick the summary model: active model unless an explicit `provider/id` override is supplied. */
export const resolveSummaryModel = (
	ctx: ExtensionToolContext,
	override?: string
): Model<Api> | undefined => {
	const trimmed = override?.trim();
	if (!trimmed) {
		return ctx.model as Model<Api> | undefined;
	}
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		return ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1)) as
			| Model<Api>
			| undefined;
	}
	if (ctx.model) {
		const sameProvider = ctx.modelRegistry.find(ctx.model.provider, trimmed);
		if (sameProvider) {
			return sameProvider as Model<Api>;
		}
	}
	return ctx.modelRegistry.getAll().find((model) => model.id === trimmed) as Model<Api> | undefined;
};

export const buildSummaryPrompt = (prompt: string, pages: PageContent[]): string => {
	const blocks = pages
		.map((page) => {
			const heading = page.title?.trim() ? `# ${page.title.trim()}\n` : "";
			return `<page url="${escapeAttribute(page.url)}">\n${heading}${page.content}\n</page>`;
		})
		.join("\n\n");
	return [
		"You are reading web page content on behalf of a coding agent.",
		"Answer the request below using only the provided content. Be concise but complete.",
		"When you rely on a page, cite its URL as a Markdown link. If the content does not answer the request, say so and note what is missing.",
		"",
		"Request:",
		prompt.trim(),
		"",
		"Web content:",
		blocks,
	].join("\n");
};

/**
 * Read fetched pages with a pi model and return the answer. The returned
 * `usage` must be attached to the calling tool result so pi folds the model's
 * token cost into the session totals.
 */
export const summarizePages = async (input: SummarizeInput): Promise<SummarizeOutput> => {
	const model = input.model ?? (input.ctx.model as Model<Api> | undefined);
	if (!model) {
		throw new Error("No active pi model is available to summarize. Select one or pass `model`.");
	}
	if (!input.ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No authentication configured for ${model.provider}/${model.id}.`);
	}

	const pages = clipPages(input.pages, input.maxChars);
	const promptText = buildSummaryPrompt(input.prompt, pages);
	const response = await input.ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				},
			],
		},
		{ cacheRetention: "none", sessionId: uuidv7() }
	);

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	return {
		text: text.length > 0 ? text : "(the model returned no text)",
		usage: response.usage,
		modelLabel: `${model.provider}/${model.id}`,
	};
};
