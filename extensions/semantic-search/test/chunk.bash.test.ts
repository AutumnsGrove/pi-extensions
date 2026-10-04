import { beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

const BASH = `#!/usr/bin/env bash
set -euo pipefail

FOO="bar"
export PATH="$PATH:/opt/bin"

greet() {
  echo "hi $1"
}

function farewell {
  echo "bye"
}
`;

describe("Bash chunker", () => {
	function chunk(source = BASH) {
		return chunkers.chunk("run.sh", source);
	}

	it("chunks shell functions (both syntaxes)", () => {
		const functions = chunk().filter((c) => c.kind === "function");
		const symbols = functions.map((c) => c.symbol).sort();
		expect(symbols).toContain("greet");
		expect(symbols).toContain("farewell");
	});

	it("chunks variable assignments", () => {
		const foo = chunk().find((c) => c.symbol === "FOO");
		expect(foo?.kind).toBe("var");
	});

	it("does not emit a chunk for the shebang", () => {
		expect(chunk().some((c) => c.content.includes("#!/usr/bin/env"))).toBe(false);
	});
});
