import { beforeAll, describe, expect, it } from "vitest";
import {
	SUPPORTED_EXTENSIONS,
	buildChunkers,
	type ChunkerSet,
} from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

describe("chunker dispatch", () => {
	it("registers every supported extension", () => {
		for (const ext of SUPPORTED_EXTENSIONS) {
			expect(chunkers.byExtension.has(ext), ext).toBe(true);
		}
	});

	it("has no registered extension outside the supported list", () => {
		const supported = new Set(SUPPORTED_EXTENSIONS);
		for (const ext of chunkers.byExtension.keys()) {
			expect(supported.has(ext), ext).toBe(true);
		}
	});

	it("returns no chunks for unsupported extensions", () => {
		expect(chunkers.chunk("a.txt", "hello")).toEqual([]);
		expect(chunkers.chunk("Makefile", "all:\n\techo hi")).toEqual([]);
	});

	it("does not throw on unparseable source", () => {
		expect(() => chunkers.chunk("broken.ts", "function ((((")).not.toThrow();
		expect(() => chunkers.chunk("broken.py", "def ((((")).not.toThrow();
	});
});
