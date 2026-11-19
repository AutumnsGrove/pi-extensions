import { describe, expect, it } from "vitest";
import {
	agentDir,
	claudeSlugForPath,
	claudeStoreDir,
	displayPath,
	memoryRoot,
	slugForPath,
	storeDirFor,
} from "../paths.ts";

describe("slugForPath", () => {
	it("matches pi's session slug", () => {
		expect(slugForPath("/Users/autumn/Documents/Projects/pi-extensions")).toBe(
			"--Users-autumn-Documents-Projects-pi-extensions--"
		);
	});

	it("handles a root directory and Windows separators", () => {
		expect(slugForPath("/")).toBe("----");
		expect(slugForPath("C:\\Users\\autumn\\code")).toBe("--C--Users-autumn-code--");
	});
});

describe("claude slug", () => {
	it("uses one leading dash and no wrapping", () => {
		expect(claudeSlugForPath("/Users/autumn/Documents/Projects/x")).toBe(
			"-Users-autumn-Documents-Projects-x"
		);
	});
});

describe("agent directories", () => {
	it("honours PI_CODING_AGENT_DIR", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe("/tmp/agent");
		expect(memoryRoot({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe("/tmp/agent/memory");
	});

	it("honours PI_MEMORY_DIR as the store itself", () => {
		const dir = storeDirFor({
			cwd: "/Users/autumn/project",
			scope: "cwd",
			store: "pi",
			env: { PI_MEMORY_DIR: "/tmp/mem" },
		});
		expect(dir).toBe("/tmp/mem");
	});

	it("maps cwd scope to the session slug", () => {
		const dir = storeDirFor({
			cwd: "/Users/autumn/project",
			scope: "cwd",
			store: "pi",
			env: { PI_CODING_AGENT_DIR: "/tmp/agent" },
		});
		expect(dir).toBe("/tmp/agent/memory/--Users-autumn-project--");
	});

	it("uses Claude's projects directory for the shared store", () => {
		const dir = claudeStoreDir("/Users/autumn/project", { projectsDir: "/tmp/claude/projects" });
		expect(dir).toBe("/tmp/claude/projects/-Users-autumn-project/memory");
	});
});

describe("displayPath", () => {
	it("shortens paths under home", () => {
		const home = process.env.HOME;
		if (!home) return;
		expect(displayPath(`${home}/Documents/x`)).toBe("~/Documents/x");
	});
});
