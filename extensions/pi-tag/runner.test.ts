import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS, piArgs, runPi } from "./runner.ts";
import type { Exec } from "./github.ts";

const base = {
	cwd: "/tmp/repo",
	system: "you are a tagger",
	context: "## the issue\n\nsomething",
	provider: "opencode-go",
	model: "glm-5.3-flash",
};

describe("piArgs", () => {
	it("runs headless with the same isolation as the reviewer", () => {
		const args = piArgs(base);
		for (const flag of [
			"--print",
			"--no-session",
			"--no-approve",
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-mcp",
			"--offline",
		]) {
			expect(args).toContain(flag);
		}
	});

	it("allows only tools that read", () => {
		expect(piArgs(base)).toContain(READ_ONLY_TOOLS);
		expect(READ_ONLY_TOOLS.split(",")).toEqual(["read", "grep", "find", "ls"]);
		expect(READ_ONLY_TOOLS).not.toContain("bash");
	});

	it("names the provider and model explicitly", () => {
		const args = piArgs(base);
		expect(args[args.indexOf("--provider") + 1]).toBe("opencode-go");
		expect(args[args.indexOf("--model") + 1]).toBe("glm-5.3-flash");
	});

	it("defaults to medium thinking and takes an override", () => {
		expect(piArgs(base)[piArgs(base).indexOf("--thinking") + 1]).toBe("medium");
		expect(piArgs({ ...base, thinking: "low" })[piArgs(base).indexOf("--thinking") + 1]).toBe("low");
	});

	it("ends with the context message, after the system prompt", () => {
		const args = piArgs(base);
		expect(args.at(-1)).toBe(base.context);
		expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(base.system);
	});
});

describe("runPi", () => {
	it("returns the model's output on success", async () => {
		const exec: Exec = async () => ({ stdout: '{"labels":[]}\n', stderr: "", code: 0 });
		const run = await runPi({ ...base, exec });
		expect(run.ok).toBe(true);
		expect(run.output).toBe('{"labels":[]}');
	});

	it("turns a non-zero exit into a failure with its stderr", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "no such model", code: 1 });
		const run = await runPi({ ...base, exec });
		expect(run.ok).toBe(false);
		expect(run.error).toBe("no such model");
	});

	it("falls back to the exit code when stderr is empty", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "", code: 137 });
		const run = await runPi({ ...base, exec });
		expect(run.error).toBe("pi exited 137");
	});

	it("runs in the checkout it was given", async () => {
		let seen = "";
		const exec: Exec = async (_cmd, _args, options) => {
			seen = options?.cwd ?? "";
			return { stdout: "", stderr: "", code: 0 };
		};
		await runPi({ ...base, exec });
		expect(seen).toBe("/tmp/repo");
	});
});
