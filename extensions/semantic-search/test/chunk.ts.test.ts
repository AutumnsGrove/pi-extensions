import { beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

const TS = `export const MAX = 10;

export function add(a: number, b: number): number {
  return a + b;
}

export const mul = (a: number, b: number) => a * b;

class Greeter {
  greet(): string {
    return "hi";
  }
}

interface Shape {
  area(): number;
}

type Point = { x: number; y: number };

enum Color {
  Red,
  Green,
}

namespace NS {
  export const inner = 1;
}
`;

const TSX = `interface Props {
  name: string;
}

export function Hello({ name }: Props) {
  return <div>Hello {name}</div>;
}

export const Badge = ({ name }: Props) => <span>{name}</span>;
`;

const JS = `export const VERSION = "1";

export function greet(name) {
  return "hi " + name;
}

export const shout = (s) => s.toUpperCase();

class Box {
  open() {
    return 1;
  }
}
`;

describe("TypeScript chunker", () => {
	function chunk(source = TS) {
		return chunkers.chunk("demo.ts", source);
	}

	it("classifies consts, functions, arrow functions", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("MAX")).toBe("const");
		expect(bySymbol.get("add")).toBe("function");
		expect(bySymbol.get("mul")).toBe("function");
	});

	it("classifies types, interfaces, enums, namespaces", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("Greeter")).toBe("type");
		expect(bySymbol.get("Shape")).toBe("interface");
		expect(bySymbol.get("Point")).toBe("type");
		expect(bySymbol.get("Color")).toBe("type");
		expect(bySymbol.get("NS")).toBe("type");
	});

	it("qualifies methods by their class", () => {
		const greet = chunk().find((c) => c.symbol === "Greeter.greet");
		expect(greet?.kind).toBe("method");
	});

	it("qualifies namespace members", () => {
		expect(chunk().some((c) => c.symbol === "NS.inner")).toBe(true);
	});

	it("does not produce chunks for comments", () => {
		expect(chunk(`// just a comment\n`).length).toBe(0);
	});
});

describe("TSX chunker", () => {
	it("finds components and arrow components", () => {
		const bySymbol = new Map(
			chunkers.chunk("demo.tsx", TSX).map((c) => [c.symbol, c.kind])
		);
		expect(bySymbol.get("Props")).toBe("interface");
		expect(bySymbol.get("Hello")).toBe("function");
		expect(bySymbol.get("Badge")).toBe("function");
	});
});

describe("JavaScript chunker", () => {
	it("finds functions, arrow functions, classes and methods", () => {
		const bySymbol = new Map(
			chunkers.chunk("demo.js", JS).map((c) => [c.symbol, c.kind])
		);
		expect(bySymbol.get("VERSION")).toBe("const");
		expect(bySymbol.get("greet")).toBe("function");
		expect(bySymbol.get("shout")).toBe("function");
		expect(bySymbol.get("Box")).toBe("type");
		expect(bySymbol.get("Box.open")).toBe("method");
	});
});

describe("chunk invariants", () => {
	it("never emits duplicate ids or overlapping identical ranges", () => {
		for (const [file, source] of [
			["demo.ts", TS],
			["demo.tsx", TSX],
			["demo.js", JS],
		] as const) {
			const chunks = chunkers.chunk(file, source);
			const ids = chunks.map((c) => c.id);
			expect(new Set(ids).size, file).toBe(ids.length);
			for (const c of chunks) {
				expect(c.startLine, file).toBeLessThanOrEqual(c.endLine);
				expect(c.content.trim().length, file).toBeGreaterThan(0);
			}
		}
	});
});
