import { beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

describe("adversarial: comments and strings", () => {
	it("does not chunk commented-out TypeScript declarations", () => {
		const source = `// function fake() {}\n/* class AlsoFake {} */\nconst s = "function fake() {}";\n`;
		const symbols = chunkers.chunk("a.ts", source).map((c) => c.symbol);
		expect(symbols).not.toContain("fake");
		expect(symbols).not.toContain("AlsoFake");
	});

	it("does not chunk commented-out Python declarations", () => {
		const source = `# def fake():\n#     pass\ns = "def fake(): pass"\n`;
		const symbols = chunkers.chunk("a.py", source).map((c) => c.symbol);
		expect(symbols).not.toContain("fake");
		expect(symbols).toContain("s");
	});
});

describe("adversarial: Python edge cases", () => {
	const source = `import asyncio

async def fetch(url):
    return url

def outer():
    def inner():
        return 1
    return inner

class Service:
    def __init__(self):
        self.x = 1

    async def run(self):
        return await fetch("x")

    def __repr__(self):
        return "Service"
`;

	it("chunks async functions", () => {
		const symbols = chunkers.chunk("a.py", source).map((c) => c.symbol);
		expect(symbols).toContain("fetch");
		expect(symbols).toContain("Service.run");
	});

	it("chunks nested functions with a qualified symbol", () => {
		const symbols = chunkers.chunk("a.py", source).map((c) => c.symbol);
		expect(symbols).toContain("outer");
		expect(symbols).toContain("outer.inner");
	});

	it("chunks dunder methods", () => {
		const symbols = chunkers.chunk("a.py", source).map((c) => c.symbol);
		expect(symbols).toContain("Service.__init__");
		expect(symbols).toContain("Service.__repr__");
	});
});

describe("adversarial: TypeScript overloads and generics", () => {
	const source = `export async function load<T>(x: T): Promise<T> {
  return x;
}

export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: unknown): unknown {
  return a;
}

export const table: Record<string, number> = { a: 1 };
`;

	it("chunks generic async functions", () => {
		const load = chunkers.chunk("a.ts", source).find((c) => c.symbol === "load");
		expect(load?.kind).toBe("function");
	});

	it("collapses overload signatures to one chunk", () => {
		const overloads = chunkers
			.chunk("a.ts", source)
			.filter((c) => c.symbol === "overloaded");
		expect(overloads).toHaveLength(1);
		expect(overloads[0]?.content).toContain("return a;");
	});

	it("keeps exported const objects", () => {
		const table = chunkers.chunk("a.ts", source).find((c) => c.symbol === "table");
		expect(table?.kind).toBe("const");
	});
});

describe("chunk invariants across languages", () => {
	const fixtures: Array<[string, string]> = [
		["a.go", `package a\n\nfunc F() {}\n`],
		["a.ts", `export function f(): void {}\n`],
		["a.tsx", `export const C = () => <div />;\n`],
		["a.js", `export function f() {}\n`],
		["a.py", `def f():\n    pass\n`],
		["a.sh", `f() { echo hi; }\n`],
		["a.json", `{"a": 1}`],
		["a.yaml", `a: 1\n`],
		["a.svelte", `<script>function f() {}</script>\n`],
	];

	it("produces well-formed chunks", () => {
		for (const [file, source] of fixtures) {
			for (const c of chunkers.chunk(file, source)) {
				expect(c.id, file).toMatch(/^[0-9a-f]{16}$/);
				expect(c.startLine, file).toBeGreaterThanOrEqual(1);
				expect(c.endLine, file).toBeGreaterThanOrEqual(c.startLine);
				expect(c.content.trim().length, file).toBeGreaterThan(0);
				expect(c.symbol.length, file).toBeGreaterThan(0);
			}
		}
	});
});
