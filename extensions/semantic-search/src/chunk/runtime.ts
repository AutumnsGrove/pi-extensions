/**
 * Tree-sitter runtime loader.
 *
 * Uses `@vscode/tree-sitter-wasm`, which ships a runtime (`tree-sitter.wasm`)
 * and a set of grammar wasm files built against the same tree-sitter ABI. That
 * matters: the popular `tree-sitter-wasms` bundle is built for an older ABI and
 * fails to load with current web-tree-sitter runtimes.
 *
 * The package is CommonJS, so it is loaded through `createRequire` instead of a
 * named ESM import. That keeps it working under Node, vitest, and pi's jiti
 * loader alike.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Language, Node as TsNode, Parser, Query } from "@vscode/tree-sitter-wasm";

const require = createRequire(import.meta.url);

interface TreeSitterRuntime {
	Parser: typeof Parser;
	Language: typeof Language;
	Query: typeof Query;
}

const runtime = require("@vscode/tree-sitter-wasm") as TreeSitterRuntime;

const wasmDir = join(
	dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
	"wasm"
);

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

function init(): Promise<void> {
	if (!initPromise) {
		initPromise = runtime.Parser.init({
			locateFile: (name: string) => join(wasmDir, name),
		});
	}
	return initPromise;
}

/** Load a grammar by base name, e.g. "go", "typescript", "tsx", "bash". */
export function loadLanguage(name: string): Promise<Language> {
	let cached = languageCache.get(name);
	if (!cached) {
		cached = (async () => {
			await init();
			return runtime.Language.load(join(wasmDir, `tree-sitter-${name}.wasm`));
		})();
		languageCache.set(name, cached);
	}
	return cached;
}

export function createParser(language: Language): Parser {
	const parser = new runtime.Parser();
	parser.setLanguage(language);
	return parser;
}

export function createQuery(language: Language, pattern: string): Query {
	return new runtime.Query(language, pattern);
}

export type { TsNode };
