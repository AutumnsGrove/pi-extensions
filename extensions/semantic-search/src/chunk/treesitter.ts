/**
 * Generic tree-sitter query chunker.
 *
 * Ported from lumen's `internal/chunker/treesitter.go`. A language definition
 * is a list of query patterns, each capturing `@decl` (the declaration node)
 * and `@name` (its identifier). Rules are ordered general → specific; when two
 * chunks share an exact line range the later rule wins, which lets a specific
 * pattern override a broader one (e.g. an exported const becoming a function).
 *
 * Improvements over lumen: enclosing-symbol qualification understands
 * TypeScript/JavaScript class bodies and Python class bodies in addition to the
 * Dart-style nodes lumen special-cased.
 */

import { type Chunk, type ChunkKind, type Chunker, makeChunk } from "./types.ts";
import {
	type TsNode,
	createParser,
	createQuery,
	loadLanguage,
} from "./runtime.ts";
import type { Language, Query } from "@vscode/tree-sitter-wasm";

export interface QueryDef {
	pattern: string;
	kind: ChunkKind;
}

export interface LanguageDef {
	/** Grammar base name passed to {@link loadLanguage}. */
	language: string;
	queries: QueryDef[];
}

const MAX_LEADING_COMMENT_LINES = 10;

interface CompiledRule {
	query: Query;
	kind: ChunkKind;
}

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

/** Node types that can own a qualified symbol (Type.Method). */
const CONTAINER_TYPES = new Set([
	"function_declaration",
	"function_definition",
	"method_definition",
	"method_declaration",
	"class_declaration",
	"class_definition",
	"class",
	"class_expression",
	"abstract_class_declaration",
	"interface_declaration",
	"internal_module",
	"module",
	"singleton_method",
	"method",
	"enum_declaration",
]);

export interface TreeSitterChunker extends Chunker {
	/** Distinct kinds produced, for capability checks. */
	readonly kinds: ReadonlySet<ChunkKind>;
}

/** Build a chunker for a language definition. Loads the grammar once. */
export async function createTreeSitterChunker(
	def: LanguageDef
): Promise<TreeSitterChunker> {
	const language = await loadLanguage(def.language);
	return createChunkerFromLanguage(language, def.queries);
}

export function createChunkerFromLanguage(
	language: Language,
	queries: QueryDef[]
): TreeSitterChunker {
	const parser = createParser(language);
	const rules: CompiledRule[] = queries.map((q) => ({
		query: createQuery(language, q.pattern),
		kind: q.kind,
	}));
	const kinds = new Set<ChunkKind>(queries.map((q) => q.kind));

	return {
		kinds,
		chunk(filePath: string, content: string): Chunk[] {
			const tree = parser.parse(content);
			if (!tree) {
				return [];
			}
			const out: Chunk[] = [];
			for (const rule of rules) {
				for (const match of rule.query.matches(tree.rootNode)) {
					let decl: TsNode | undefined;
					let nameNode: TsNode | undefined;
					for (const capture of match.captures) {
						if (capture.name === "decl") {
							decl = capture.node;
						} else if (capture.name === "name") {
							nameNode = capture.node;
						}
					}
					if (!decl || !nameNode) {
						continue;
					}
					const symbol = resolveSymbol(decl, nameNode.text, content);
					let startLine = decl.startPosition.row + 1;
					let startIndex = decl.startIndex;
					const comment = findLeadingComments(decl);
					if (comment) {
						startLine = comment.startPosition.row + 1;
						startIndex = comment.startIndex;
					}
					const endLine = decl.endPosition.row + 1;
					const snippet = content.slice(startIndex, decl.endIndex);
					out.push(
						makeChunk(filePath, symbol, rule.kind, startLine, endLine, snippet)
					);
				}
			}
			tree.delete();
			return deduplicateBySymbol(deduplicateByExactRange(out));
		},
	};
}

function resolveSymbol(decl: TsNode, name: string, content: string): string {
	// Go methods carry their receiver type on the declaration itself.
	if (decl.type === "method_declaration") {
		const receiver = goReceiverType(decl);
		if (receiver) {
			return `${receiver}.${name}`;
		}
	}
	const parent = findEnclosingSymbol(decl, content);
	return parent ? `${parent}.${name}` : name;
}

function goReceiverType(decl: TsNode): string | undefined {
	const receiver = decl.childForFieldName("receiver");
	if (!receiver) {
		return undefined;
	}
	const typeId = receiver
		.descendantsOfType("type_identifier")
		.find((node): node is TsNode => node !== null);
	return typeId?.text;
}

/** Nearest enclosing declaration name, or "" when the node is top-level. */
export function findEnclosingSymbol(node: TsNode, _content: string): string {
	let current = node.parent;
	while (current) {
		if (CONTAINER_TYPES.has(current.type)) {
			const nameNode = current.childForFieldName("name");
			if (nameNode) {
				return nameNode.text;
			}
		}
		// Arrow functions assigned to a variable: qualify by the variable name.
		if (current.type === "variable_declarator") {
			const value = current.childForFieldName("value");
			const valueType = value?.type;
			if (
				valueType === "arrow_function" ||
				valueType === "function_expression" ||
				valueType === "generator_function"
			) {
				const nameNode = current.childForFieldName("name");
				if (nameNode) {
					return nameNode.text;
				}
			}
		}
		current = current.parent;
	}
	return "";
}

function isCommentNode(type: string): boolean {
	return COMMENT_TYPES.has(type);
}

/**
 * The runtime exposes `nextNamedSibling` but not `prevNamedSibling`, so walk
 * the parent's named children backwards to find the previous named sibling.
 */
function previousNamedSibling(node: TsNode): TsNode | null {
	const parent = node.parent;
	if (!parent) {
		return null;
	}
	const children = parent.namedChildren.filter(
		(child): child is TsNode => child !== null
	);
	const index = children.findIndex((child) => child.equals(node));
	if (index <= 0) {
		return null;
	}
	return children[index - 1] ?? null;
}

/** Earliest comment immediately preceding `node`, or undefined. */
export function findLeadingComments(node: TsNode): TsNode | undefined {
	let earliest: TsNode | undefined;
	let nextRow = node.startPosition.row;
	let commentLines = 0;
	for (
		let sibling = previousNamedSibling(node);
		sibling;
		sibling = previousNamedSibling(sibling)
	) {
		if (!isCommentNode(sibling.type)) {
			break;
		}
		const endRow = sibling.endPosition.row;
		const endCol = sibling.endPosition.column;
		const adjacent =
			endRow === nextRow || (endCol !== 0 && endRow + 1 === nextRow);
		if (!adjacent) {
			break;
		}
		const siblingLines = endRow - sibling.startPosition.row + 1;
		if (commentLines + siblingLines > MAX_LEADING_COMMENT_LINES) {
			break;
		}
		commentLines += siblingLines;
		earliest = sibling;
		nextRow = sibling.startPosition.row;
	}
	return earliest;
}

/** Drop chunks sharing an exact (startLine, endLine); later rules win. */
export function deduplicateByExactRange(chunks: Chunk[]): Chunk[] {
	if (chunks.length <= 1) {
		return chunks;
	}
	const best = new Map<string, number>();
	for (let i = 0; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		if (chunk) {
			best.set(`${chunk.startLine}:${chunk.endLine}`, i);
		}
	}
	const keep = new Set(best.values());
	return chunks.filter((_, index) => keep.has(index));
}

/**
 * Collapse near-duplicates that share a symbol and kind (for example a Python
 * function emitted both by the plain `function_definition` rule and the
 * `decorated_definition` rule). The chunk with the most content wins, because
 * that is the one that includes the decorators.
 */
export function deduplicateBySymbol(chunks: Chunk[]): Chunk[] {
	if (chunks.length <= 1) {
		return chunks;
	}
	const best = new Map<string, number>();
	for (let i = 0; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		if (!chunk) {
			continue;
		}
		const key = `${chunk.kind}\u0000${chunk.symbol}`;
		const previous = best.get(key);
		if (
			previous === undefined ||
			(chunks[previous]?.content.length ?? 0) < chunk.content.length
		) {
			best.set(key, i);
		}
	}
	const keep = new Set(best.values());
	return chunks.filter((_, index) => keep.has(index));
}
