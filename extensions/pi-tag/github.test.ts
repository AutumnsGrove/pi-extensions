import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GhError, type Exec, evidenceFor, nodeExec, readCheckout, readIssue } from "./github.ts";

const ghJson = JSON.stringify({
	number: 1657,
	title: "Shutter: promote the TypeScript port",
	body: "The port lives in `libs/shutter/cloudflare`.",
	labels: [{ name: "tech-debt" }, { name: "pattern:songbird" }],
	state: "OPEN",
	url: "https://github.com/o/r/issues/1657",
	author: { login: "AutumnsGrove" },
});

function fake(stdout: string, code = 0, stderr = ""): Exec {
	return async () => ({ stdout, stderr, code });
}

describe("readIssue", () => {
	it("reads the stored issue, not an event echo", async () => {
		const issue = await readIssue(fake(ghJson), "/repo", 1657);
		expect(issue).toEqual({
			number: 1657,
			title: "Shutter: promote the TypeScript port",
			body: "The port lives in `libs/shutter/cloudflare`.",
			labels: ["tech-debt", "pattern:songbird"],
			state: "OPEN",
			url: "https://github.com/o/r/issues/1657",
			author: "AutumnsGrove",
		});
	});

	it("asks gh for exactly what it uses", async () => {
		let args: string[] = [];
		const exec: Exec = async (_cmd, seen) => {
			args = seen;
			return { stdout: ghJson, stderr: "", code: 0 };
		};
		await readIssue(exec, "/repo", 1657);
		expect(args).toEqual([
			"issue",
			"view",
			"1657",
			"--json",
			"number,title,body,labels,state,url,author",
		]);
	});

	it("survives a missing body, labels, or title", async () => {
		const issue = await readIssue(fake('{"number":7,"state":"OPEN"}'), "/repo", 7);
		expect(issue.body).toBe("");
		expect(issue.labels).toEqual([]);
		expect(issue.title).toBe("");
	});

	it("reports a closed issue as closed rather than guessing", async () => {
		const issue = await readIssue(fake('{"number":7,"state":"CLOSED"}'), "/repo", 7);
		expect(issue.state).toBe("CLOSED");
	});

	it("throws with gh's own words when the call fails", async () => {
		await expect(readIssue(fake("", 1, "not found"), "/repo", 9)).rejects.toThrow(GhError);
		try {
			await readIssue(fake("", 1, "not found"), "/repo", 9);
		} catch (error) {
			expect((error as GhError).stderr).toBe("not found");
		}
	});

	it("throws when gh answers with something that is not JSON", async () => {
		await expect(readIssue(fake("<html>"), "/repo", 9)).rejects.toThrow(/did not return JSON/);
	});
});

describe("readCheckout", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tag-co-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("refuses a repository with no manifest", () => {
		expect(() => readCheckout(root)).toThrow(/no \.github\/labels\.yml/);
	});

	it("reads the vocabulary and the tree", () => {
		mkdirSync(join(root, ".github"), { recursive: true });
		mkdirSync(join(root, "libs", "engine"), { recursive: true });
		writeFileSync(join(root, "libs", "engine", "package.json"), "{}\n");
		writeFileSync(
			join(root, ".github", "labels.yml"),
			`version: 1
policy:
  max_per_group: { type: 1 }
  auto_groups: [type]
labels:
  - name: bug
    group: type
    description: Broken
    when: It worked before.
`
		);
		const checkout = readCheckout(root);
		expect(checkout.manifest.labels.map((label) => label.name)).toEqual(["bug"]);
		expect(checkout.evidence.exists("libs/engine/package.json")).toBe(true);
		expect(checkout.evidence.exists("libs/engine/ghost.ts")).toBe(false);
		expect(evidenceFor(checkout, "a title").title).toBe("a title");
	});
});

describe("nodeExec", () => {
	it("closes stdin instead of handing the child an open pipe", async () => {
		// A child that waits for stdin must not wait forever: `execFile` leaves the
		// pipe open, and pi's print mode reads it when it is not a terminal. This is
		// the regression test for a run that hung for five minutes with no output.
		const result = await nodeExec("node", ["-e", "process.stdin.resume()"], { timeoutMs: 5_000 });
		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(0);
	}, 10_000);

	it("captures both streams", async () => {
		const result = await nodeExec("node", ["-e", "console.log('out'); console.error('err')"]);
		expect(result.stdout.trim()).toBe("out");
		expect(result.stderr.trim()).toBe("err");
		expect(result.code).toBe(0);
	});

	it("says when the clock ran out, rather than pretending it failed", async () => {
		const result = await nodeExec("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 150 });
		expect(result.timedOut).toBe(true);
		expect(result.code).toBe(124);
	}, 10_000);

	it("reports a missing binary instead of throwing", async () => {
		const result = await nodeExec("pi-tag-command-that-does-not-exist", []);
		expect(result.code).toBe(127);
	});
});
