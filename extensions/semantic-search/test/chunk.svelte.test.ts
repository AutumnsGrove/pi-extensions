import { beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";

let chunkers: ChunkerSet;

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

const SVELTE = `<script lang="ts">
  export let name: string;
  const greet = (n: string) => \`hi \${n}\`;
  function helper() {
    return 1;
  }
</script>

<h1>Hello {name}</h1>

<script module>
  export const VERSION = "1";
</script>
`;

describe("Svelte chunker", () => {
	function chunk(source = SVELTE) {
		return chunkers.chunk("Demo.svelte", source);
	}

	it("extracts script-block symbols", () => {
		const bySymbol = new Map(chunk().map((c) => [c.symbol, c.kind]));
		expect(bySymbol.get("name")).toBe("const");
		expect(bySymbol.get("greet")).toBe("function");
		expect(bySymbol.get("helper")).toBe("function");
		expect(bySymbol.get("VERSION")).toBe("const");
	});

	it("reports file-relative line numbers", () => {
		const helper = chunk().find((c) => c.symbol === "helper");
		expect(helper?.startLine).toBe(4);
		const version = chunk().find((c) => c.symbol === "VERSION");
		expect(version?.startLine).toBe(12);
	});

	it("returns nothing when there is no script block", () => {
		expect(chunk(`<h1>hi</h1>\n`).length).toBe(0);
	});

	it("handles a script block with no symbols", () => {
		expect(chunk(`<script>console.log("x");</script>\n`).length).toBe(0);
	});
});
