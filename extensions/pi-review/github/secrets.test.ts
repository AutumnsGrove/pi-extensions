import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { type CommandRunner, spawnRunner } from "./exec.ts";
import {
	APP_ID_SECRET,
	APP_KEY_SECRET,
	APP_SLUG_VARIABLE,
	deleteRepoSecret,
	deleteRepoVariable,
	getRepoVariable,
	listRepoSecretNames,
	setRepoSecret,
	setRepoVariable,
} from "./secrets.ts";

interface Call {
	command: string;
	args: string[];
	stdin?: string;
}

function fakeRunner(
	respond: (call: Call) => { stdout?: string; stderr?: string; code?: number } = () => ({
		stdout: "",
		code: 0,
	})
): CommandRunner & { calls: Call[] } {
	const calls: Call[] = [];
	const runner = async (command: string, args: string[], options: { cwd: string; stdin?: string }) => {
		const call = { command, args, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) };
		calls.push(call);
		const result = respond(call);
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
	};
	return Object.assign(runner, { calls });
}

const repo = { owner: "owner", repo: "repo" };
const cwd = "/repo";

describe("listRepoSecretNames", () => {
	it("parses one name per line", async () => {
		const run = fakeRunner(() => ({ stdout: `${APP_ID_SECRET}\n${APP_KEY_SECRET}\n\n` }));
		expect(await listRepoSecretNames({ run, repo, cwd })).toEqual([APP_ID_SECRET, APP_KEY_SECRET]);
		expect(run.calls[0]!.args).toEqual([
			"api",
			"repos/owner/repo/actions/secrets?per_page=100",
			"--jq",
			".secrets[].name",
		]);
	});

	it("throws with gh's message", async () => {
		const run = fakeRunner(() => ({ stderr: "Must have admin rights", code: 1 }));
		await expect(listRepoSecretNames({ run, repo, cwd })).rejects.toThrow("Must have admin rights");
	});
});

describe("setRepoSecret", () => {
	it("writes the value on stdin, never in argv", async () => {
		const run = fakeRunner();
		await setRepoSecret({ run, repo, cwd, name: APP_KEY_SECRET, value: "pem-value" });
		expect(run.calls[0]).toEqual({
			command: "gh",
			args: ["secret", "set", APP_KEY_SECRET, "--repo", "owner/repo"],
			stdin: "pem-value",
		});
		expect(run.calls[0]!.args.join(" ")).not.toContain("pem-value");
	});

	it("throws when the secret cannot be stored", async () => {
		const run = fakeRunner(() => ({ stderr: "HTTP 403", code: 1 }));
		await expect(
			setRepoSecret({ run, repo, cwd, name: APP_ID_SECRET, value: "1" })
		).rejects.toThrow("HTTP 403");
	});
});

describe("delete helpers", () => {
	it("deletes a secret", async () => {
		const run = fakeRunner();
		await deleteRepoSecret({ run, repo, cwd, name: APP_ID_SECRET });
		expect(run.calls[0]!.args).toEqual(["secret", "delete", APP_ID_SECRET, "--repo", "owner/repo"]);
	});

	it("reads a variable, returning undefined when it is missing", async () => {
		const present = fakeRunner(() => ({ stdout: "pi-review-x\n" }));
		expect(await getRepoVariable({ run: present, repo, cwd, name: APP_SLUG_VARIABLE })).toBe(
			"pi-review-x"
		);
		const missing = fakeRunner(() => ({ stderr: "not found", code: 1 }));
		expect(await getRepoVariable({ run: missing, repo, cwd, name: APP_SLUG_VARIABLE })).toBeUndefined();
	});

	it("sets a variable with --body", async () => {
		const run = fakeRunner();
		await setRepoVariable({ run, repo, cwd, name: APP_SLUG_VARIABLE, value: "pi-review-x" });
		expect(run.calls[0]!.args).toEqual([
			"variable",
			"set",
			APP_SLUG_VARIABLE,
			"--body",
			"pi-review-x",
			"--repo",
			"owner/repo",
		]);
	});

	it("ignores a missing variable on delete", async () => {
		const run = fakeRunner(() => ({ stderr: "HTTP 404: Not Found", code: 1 }));
		await expect(
			deleteRepoVariable({ run, repo, cwd, name: APP_SLUG_VARIABLE })
		).resolves.toBeUndefined();
	});
});

describe("spawnRunner", () => {
	it("writes stdin and captures stdout", async () => {
		const result = await spawnRunner(
			process.execPath,
			["-e", "process.stdin.pipe(process.stdout)"],
			{ cwd: tmpdir(), stdin: "hello stdin", timeoutMs: 5_000 }
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("hello stdin");
	});

	it("captures a nonzero exit and stderr", async () => {
		const result = await spawnRunner(
			process.execPath,
			["-e", "console.error('nope'); process.exit(3)"],
			{ cwd: tmpdir(), timeoutMs: 5_000 }
		);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("nope");
	});

	it("reports a missing command instead of throwing", async () => {
		const result = await spawnRunner("definitely-not-a-command-xyz", [], {
			cwd: tmpdir(),
			timeoutMs: 5_000,
		});
		expect(result.code).toBe(127);
	});
});
