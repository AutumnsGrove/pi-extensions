import { beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

const SOURCE = `// Package demo is a demo.
package demo

// Add adds two ints.
func Add(a, b int) int {
	return a + b
}

type Greeter struct {
	Name string
}

// Greet greets.
func (g *Greeter) Greet() string {
	return "hi " + g.Name
}

type Stringer interface {
	String() string
}

const Answer = 42

var Debug = false
`;

function chunk(source = SOURCE) {
	return chunkers.chunk("demo.go", source);
}

describe("GoASTChunker (tree-sitter-go)", () => {
	it("chunks functions", () => {
		const add = chunk().find((c) => c.symbol === "Add");
		expect(add?.kind).toBe("function");
		expect(add?.content).toContain("func Add");
	});

	it("chunks methods with receiver-qualified symbols", () => {
		const greet = chunk().find((c) => c.symbol === "Greeter.Greet");
		expect(greet?.kind).toBe("method");
		expect(greet?.content).toContain("func (g *Greeter) Greet()");
	});

	it("chunks types", () => {
		const greeter = chunk().find((c) => c.symbol === "Greeter");
		expect(greeter?.kind).toBe("type");
	});

	it("chunks interfaces", () => {
		const stringer = chunk().find((c) => c.symbol === "Stringer");
		expect(stringer?.kind).toBe("interface");
	});

	it("chunks consts and vars", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("Answer")).toBe("const");
		expect(bySymbol.get("Debug")).toBe("var");
	});

	it("includes the leading doc comment", () => {
		const add = chunk().find((c) => c.symbol === "Add");
		expect(add?.startLine).toBe(4);
		expect(add?.content).toContain("// Add adds two ints.");
	});

	it("produces deterministic ids", () => {
		const first = chunk().map((c) => c.id);
		const second = chunk().map((c) => c.id);
		expect(first).toEqual(second);
		expect(new Set(first).size).toBe(first.length);
	});

	it("does not emit a package chunk", () => {
		expect(chunk().some((c) => c.symbol === "demo")).toBe(false);
	});

	it("keeps line ranges inside the file and non-empty content", () => {
		const lineCount = SOURCE.split("\n").length;
		for (const c of chunk()) {
			expect(c.startLine).toBeGreaterThanOrEqual(1);
			expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
			expect(c.endLine).toBeLessThanOrEqual(lineCount);
			expect(c.content.trim().length).toBeGreaterThan(0);
		}
	});
});
