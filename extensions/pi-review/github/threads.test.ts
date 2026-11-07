import { describe, expect, it } from "vitest";
import type { Exec } from "../detect.ts";
import {
	type ResolveResult,
	createResolveThreadsTool,
	fetchBotThreads,
	resolveThreads,
} from "./threads.ts";

const repo = { owner: "owner", repo: "repo" };

const payload = {
	data: {
		repository: {
			pullRequest: {
				reviewThreads: {
					nodes: [
						{
							id: "T1",
							isResolved: false,
							isOutdated: false,
							path: "src/app.ts",
							line: 3,
							comments: {
								nodes: [
									{
										body: "The null check is missing.",
										author: { login: "pi-review-x[bot]", __typename: "Bot" },
									},
								],
							},
						},
						{
							id: "T2",
							isResolved: true,
							isOutdated: false,
							path: "src/app.ts",
							line: 9,
							comments: {
								nodes: [{ body: "old", author: { login: "pi-review-x[bot]", __typename: "Bot" } }],
							},
						},
						{
							id: "T3",
							isResolved: false,
							path: "src/app.ts",
							line: 12,
							comments: {
								nodes: [{ body: "human", author: { login: "someone", __typename: "User" } }],
							},
						},
					],
				},
			},
		},
	},
};

function fakeExec(result: { stdout?: string; stderr?: string; code?: number } = {}) {
	const calls: string[][] = [];
	const exec: Exec = async (_command, args) => {
		calls.push(args);
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
	};
	return Object.assign(exec, { calls });
}

describe("fetchBotThreads", () => {
	it("keeps only unresolved bot threads and parses location", async () => {
		const exec = fakeExec({ stdout: JSON.stringify(payload) });
		const threads = await fetchBotThreads(exec, "/repo", repo, 3);
		expect(threads).toEqual([
			{
				id: "T1",
				path: "src/app.ts",
				line: 3,
				isOutdated: false,
				body: "The null check is missing.",
				author: "pi-review-x[bot]",
			},
		]);
		expect(exec.calls[0]).toContain("graphql");
		expect(exec.calls[0]!.join(" ")).toContain("owner=owner");
	});

	it("throws when gh fails", async () => {
		await expect(fetchBotThreads(fakeExec({ code: 1, stderr: "nope" }), "/repo", repo, 3)).rejects.toThrow(
			"Could not read review threads"
		);
	});

	it("throws on malformed JSON", async () => {
		await expect(fetchBotThreads(fakeExec({ stdout: "x" }), "/repo", repo, 3)).rejects.toThrow(
			"not JSON"
		);
	});
});

describe("resolveThreads", () => {
	it("reports per-thread success and failure", async () => {
		let call = 0;
		const exec: Exec = async () => {
			call += 1;
			return call === 1
				? { stdout: "{}", stderr: "", code: 0 }
				: { stdout: "", stderr: "boom", code: 1 };
		};
		const result = await resolveThreads(exec, "/repo", ["T1", "T2"]);
		expect(result.resolved).toEqual(["T1"]);
		expect(result.failed).toEqual([{ id: "T2", error: "boom" }]);
	});
});

describe("resolve_review_threads tool", () => {
	const thread = {
		id: "T1",
		path: "src/app.ts",
		line: 3,
		isOutdated: false,
		body: "finding",
	};

	function tool(
		resolve: (ids: string[]) => Promise<ResolveResult> = async (ids) => ({ resolved: ids, failed: [] })
	) {
		return createResolveThreadsTool({
			getThreads: async () => [thread],
			resolve,
		});
	}

	it("resolves only ids from the fetched set", async () => {
		const resolved: string[][] = [];
		const instance = createResolveThreadsTool({
			getThreads: async () => [thread],
			resolve: async (ids) => {
				resolved.push(ids);
				return { resolved: ids, failed: [] };
			},
		});
		const result = await instance.execute(
			"call",
			{ threadIds: ["T1", "T9"], reason: "fixed by the new guard" },
			undefined,
			undefined,
			{} as never
		);
		expect(resolved).toEqual([["T1"]]);
		expect(result.isError).toBeUndefined();
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toContain("Resolved 1 thread");
		expect(text).toContain("Ignored unknown ids: T9");
	});

	it("rejects a call with no known ids", async () => {
		const result = await tool().execute(
			"call",
			{ threadIds: ["T9"] },
			undefined,
			undefined,
			{} as never
		);
		expect(result.isError).toBe(true);
	});

	it("reports a failed resolution as an error when nothing resolved", async () => {
		const instance = tool(async () => ({ resolved: [], failed: [{ id: "T1", error: "boom" }] }));
		const result = await instance.execute("call", { threadIds: ["T1"] }, undefined, undefined, {} as never);
		expect(result.isError).toBe(true);
	});
});
