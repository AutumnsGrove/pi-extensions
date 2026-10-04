import { beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

const PYTHON = `import os

MAX = 10
NAME = "demo"


def add(a, b):
    return a + b


@decorator
def decorated(x):
    return x


class Greeter:
    def greet(self):
        return "hi"

    @property
    def name(self):
        return "x"
`;

describe("Python chunker", () => {
	function chunk(source = PYTHON) {
		return chunkers.chunk("demo.py", source);
	}

	it("chunks module-level assignments", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("MAX")).toBe("var");
		expect(bySymbol.get("NAME")).toBe("var");
	});

	it("chunks functions and decorated functions", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("add")).toBe("function");
		expect(bySymbol.get("decorated")).toBe("function");
		const decorated = chunk().find((c) => c.symbol === "decorated");
		expect(decorated?.content).toContain("@decorator");
	});

	it("chunks classes and qualifies methods", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("Greeter")).toBe("type");
		expect(bySymbol.get("Greeter.greet")).toBe("function");
		expect(bySymbol.get("Greeter.name")).toBe("function");
	});

	it("ignores comments", () => {
		expect(chunk("# only a comment\n").length).toBe(0);
	});
});
