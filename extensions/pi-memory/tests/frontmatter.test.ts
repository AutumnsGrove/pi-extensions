import { describe, expect, it } from "vitest";
import {
	composeBody,
	filenameFor,
	nameFromFilename,
	parseMemory,
	serializeMemory,
	splitFrontmatter,
	typeFromFilename,
} from "../frontmatter.ts";

describe("splitFrontmatter", () => {
	it("splits yaml from the body", () => {
		const parsed = splitFrontmatter("---\nname: A\ntype: feedback\n---\n\nBody\n");
		expect(parsed?.data.name).toBe("A");
		expect(parsed?.body).toBe("Body\n");
	});

	it("returns undefined without frontmatter", () => {
		expect(splitFrontmatter("Just a note.\n")).toBeUndefined();
	});

	it("treats an unterminated fence as body", () => {
		expect(splitFrontmatter("---\nname: A\nbody\n")).toBeUndefined();
	});

	it("survives invalid yaml", () => {
		expect(splitFrontmatter("---\nname: [unclosed\n---\nbody")).toBeUndefined();
	});

	it("normalises CRLF", () => {
		const parsed = splitFrontmatter("---\r\nname: A\r\n---\r\nbody\r\n");
		expect(parsed?.data.name).toBe("A");
		expect(parsed?.body).toBe("body\n");
	});
});

describe("parseMemory", () => {
	it("reads the full frontmatter shape", () => {
		const text = serializeMemory({
			name: "Use pnpm",
			description: "Never npm here",
			type: "feedback",
			body: "Use pnpm.\n\n**Why:** lockfile.",
		});
		const memory = parseMemory("feedback_pnpm.md", text);
		expect(memory).toEqual({
			name: "Use pnpm",
			description: "Never npm here",
			type: "feedback",
			body: "Use pnpm.\n\n**Why:** lockfile.",
		});
	});

	it("fills missing fields from the filename and body", () => {
		const memory = parseMemory("project_auth_rewrite.md", "The rewrite was compliance-driven.\n");
		expect(memory?.name).toBe("auth rewrite");
		expect(memory?.type).toBe("project");
		expect(memory?.description).toBe("The rewrite was compliance-driven.");
	});

	it("falls back to project for an unknown type", () => {
		const memory = parseMemory("feedback_x.md", "---\ntype: alien\n---\n\nBody\n");
		expect(memory?.type).toBe("feedback");
	});

	it("skips an empty body", () => {
		expect(parseMemory("feedback_x.md", "---\nname: X\n---\n\n   \n")).toBeUndefined();
	});
});

describe("filename helpers", () => {
	it("builds a type-prefixed slug", () => {
		expect(filenameFor("feedback", "Use pnpm, not npm")).toBe("feedback_use_pnpm_not_npm.md");
		expect(filenameFor("user", "!!!")).toBe("user_memory.md");
	});

	it("recovers the type and a readable name", () => {
		expect(typeFromFilename("feedback_pnpm.md")).toBe("feedback");
		expect(typeFromFilename("notes.md")).toBeUndefined();
		expect(nameFromFilename("feedback_pnpm.md")).toBe("pnpm");
		expect(nameFromFilename("pnpm.md")).toBe("pnpm");
	});
});

describe("composeBody", () => {
	it("adds why and how once", () => {
		const body = composeBody({
			name: "n",
			description: "d",
			type: "feedback",
			body: "Use pnpm.",
			why: "Lockfile stability.",
			howToApply: "Run pnpm.",
		});
		expect(body).toBe("Use pnpm.\n\n**Why:** Lockfile stability.\n\n**How to apply:** Run pnpm.");
		const again = composeBody({
			name: "n",
			description: "d",
			type: "feedback",
			body,
			why: "Lockfile stability.",
			howToApply: "Run pnpm.",
		});
		expect(again).toBe(body);
	});
});
