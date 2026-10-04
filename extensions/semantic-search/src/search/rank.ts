/**
 * Search result ranking, ported from lumen's `cmd/stdio.go`:
 * source-code kinds get a boost, test files are demoted, and overlapping or
 * adjacent chunks from the same file are merged.
 */

import { basename, dirname, extname } from "node:path";

export interface RankedItem {
	filePath: string;
	symbol: string;
	kind: string;
	startLine: number;
	endLine: number;
	score: number;
	content?: string;
}

const SOURCE_CODE_KINDS = new Set([
	"function",
	"method",
	"type",
	"interface",
	"const",
	"var",
]);

/** Boost source declarations; demote test files so implementation outranks tests. */
export function boostedScore(score: number, kind: string, filePath: string): number {
	let result = score;
	if (SOURCE_CODE_KINDS.has(kind)) {
		result = Math.min(1, result * 1.15);
	}
	if (isTestFile(filePath)) {
		result *= 0.75;
	}
	return result;
}

/** Test-file detection across common language conventions. */
export function isTestFile(filePath: string): boolean {
	const lower = filePath.split(/[/\\]/).join("/").toLowerCase();
	const base = basename(lower);
	const ext = extname(base);
	const nameNoExt = ext.length > 0 ? base.slice(0, -ext.length) : base;

	if (
		nameNoExt.endsWith("_test") ||
		nameNoExt.endsWith("_spec") ||
		nameNoExt.endsWith(".test") ||
		nameNoExt.endsWith(".spec") ||
		nameNoExt.startsWith("test_") ||
		base.includes(".test.") ||
		base.includes(".spec.")
	) {
		return true;
	}

	let dir = dirname(lower);
	while (dir !== "." && dir !== "/" && dir !== "") {
		const segment = dir.split("/").pop();
		if (segment === "test" || segment === "tests" || segment === "__tests__") {
			return true;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return false;
}

const ADJACENCY_GAP = 5;

/**
 * Merge results from the same file whose line ranges overlap or are within
 * 5 lines. The highest score wins and symbols are joined with "+".
 */
export function mergeOverlappingResults(items: readonly RankedItem[]): RankedItem[] {
	if (items.length === 0) {
		return [];
	}
	const groups = new Map<string, RankedItem[]>();
	const order: string[] = [];
	for (const item of items) {
		const existing = groups.get(item.filePath);
		if (existing) {
			existing.push(item);
		} else {
			groups.set(item.filePath, [item]);
			order.push(item.filePath);
		}
	}

	const merged: RankedItem[] = [];
	for (const filePath of order) {
		const group = [...(groups.get(filePath) ?? [])].sort(
			(a, b) => a.startLine - b.startLine
		);
		let current = group[0];
		if (!current) {
			continue;
		}
		for (const next of group.slice(1)) {
			if (next.startLine <= current.endLine + ADJACENCY_GAP) {
				if (next.endLine > current.endLine) {
					current = { ...current, endLine: next.endLine };
				}
				if (next.score > current.score) {
					current = { ...current, score: next.score, kind: next.kind };
				}
				if (!current.symbol.includes(next.symbol)) {
					current = { ...current, symbol: `${current.symbol}+${next.symbol}` };
				}
			} else {
				merged.push(current);
				current = next;
			}
		}
		merged.push(current);
	}
	return merged;
}
