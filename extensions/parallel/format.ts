import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ParallelExtractResponse, ParallelSearchResponse } from "./client.ts";

export interface PageContent {
	url: string;
	title?: string | null;
	content: string;
}

/** Truncate model-facing output to pi's standard head limits. */
export const truncateForModel = (text: string): string => {
	const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!result.truncated) {
		return text;
	}
	return `${result.content}\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)})]`;
};

const indent = (value: string): string => value.replace(/\n/g, "\n   ");

export const formatSearchResults = (response: ParallelSearchResponse): string => {
	if (response.results.length === 0) {
		return "Parallel returned no results.";
	}
	const lines: string[] = [`Parallel returned ${response.results.length} result(s).`, ""];
	response.results.forEach((result, index) => {
		const title = result.title?.trim() || result.url;
		lines.push(`${index + 1}. [${title}](${result.url})`);
		if (result.publish_date) {
			lines.push(`   Published: ${result.publish_date}`);
		}
		for (const excerpt of result.excerpts) {
			const text = excerpt.trim();
			if (text.length > 0) {
				lines.push(`   ${indent(text)}`);
			}
		}
		lines.push("");
	});
	return lines.join("\n").trimEnd();
};

export const pageContents = (
	response: ParallelExtractResponse,
	preferFullContent: boolean
): PageContent[] =>
	response.results.map((result) => ({
		url: result.url,
		title: result.title,
		content:
			preferFullContent && result.full_content
				? result.full_content
				: result.excerpts.join("\n\n"),
	}));

export const formatExtractResults = (response: ParallelExtractResponse): string => {
	if (response.results.length === 0) {
		return "Parallel extracted no content.";
	}
	const lines: string[] = [`Parallel extracted ${response.results.length} page(s).`, ""];
	response.results.forEach((result, index) => {
		const title = result.title?.trim() || result.url;
		lines.push(`${index + 1}. [${title}](${result.url})`);
		if (result.publish_date) {
			lines.push(`   Published: ${result.publish_date}`);
		}
		const body = pageContents({ ...response, results: [result] }, true)[0]?.content ?? "";
		if (body.trim().length > 0) {
			lines.push(`   ${indent(body.trim())}`);
		}
		lines.push("");
	});
	return lines.join("\n").trimEnd();
};

/** Fit pages into a total character budget, preserving per-page attribution. */
export const clipPages = (pages: PageContent[], maxChars: number): PageContent[] => {
	if (maxChars <= 0) {
		return pages.map((page) => ({ ...page, content: "" }));
	}
	const perPage = Math.max(1, Math.floor(maxChars / Math.max(1, pages.length)));
	return pages.map((page) => {
		if (page.content.length <= perPage) {
			return page;
		}
		return {
			...page,
			content: `${page.content.slice(0, perPage)}\n\n[Content truncated to fit the summarizer context.]`,
		};
	});
};
