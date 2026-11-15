import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateInto } from "./index.ts";
import { WORKFLOW_PATH } from "./settings.ts";

const root = mkdtempSync(join(tmpdir(), "pi-tag-gen-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(settings: unknown): string {
	const dir = mkdtempSync(join(root, "repo-"));
	mkdirSync(join(dir, ".github"), { recursive: true });
	writeFileSync(join(dir, ".github", "pi-tag.json"), JSON.stringify(settings));
	return dir;
}

describe("generateInto", () => {
	it("writes the workflow the settings describe", () => {
		const dir = repo({ version: 1, model: "glm-5.3-flash" });
		const result = generateInto(dir, { ref: "abc123" });
		expect(result.changed).toBe(true);
		expect(result.path.endsWith(WORKFLOW_PATH)).toBe(true);
		const body = readFileSync(result.path, "utf8");
		expect(body).toContain("name: pi-tag");
		expect(body).toContain("origin 'abc123'");
	});

	it("says when nothing would change, so a regenerate is not a diff", () => {
		const dir = repo({ version: 1 });
		expect(generateInto(dir, { ref: "r" }).changed).toBe(true);
		expect(generateInto(dir, { ref: "r" }).changed).toBe(false);
	});

	it("refuses a settings file it cannot trust", () => {
		const dir = repo({ version: 1, tools: { bash: true } });
		expect(() => generateInto(dir, { ref: "r" })).toThrow(/never runs a shell/);
	});
});
