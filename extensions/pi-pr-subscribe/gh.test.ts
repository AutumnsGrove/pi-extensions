import { describe, expect, it } from "vitest";
import { diffSnapshot, initCursor } from "./diff.ts";
import {
	GhApi,
	GhApiError,
	contextsFromProtection,
	contextsFromRules,
	fetchSnapshot,
	parseIncludedResponse,
	requiredChecks,
	retryDelayMs,
	snapshotPaths,
	type Exec,
} from "./gh.ts";

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; throw?: string; code?: number };

const included = (status: number, body?: unknown, headers: Record<string, string> = {}): string => {
	const merged = { "Content-Type": "application/json", ...headers };
	const head = `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Not Modified"}\r\n${Object.entries(merged)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\r\n")}`;
	return `${head}\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`;
};

function fakeExec(replies: Array<{ match: string; reply: Reply }>): { exec: Exec; calls: string[][] } {
	const calls: string[][] = [];
	const exec: Exec = async (_command, args) => {
		calls.push(args);
		const path = args.at(-1) ?? "";
		for (const { match, reply } of replies) {
			if (!path.includes(match)) continue;
			if (reply.throw) throw new Error(reply.throw);
			const replyHeaders = { ...(reply.body !== undefined ? {} : {}), ...(reply.headers ?? {}) };
			const body = reply.status === 304 ? undefined : reply.body;
			return { stdout: included(reply.status, body, replyHeaders), code: reply.code ?? (reply.status >= 400 ? 1 : 0) };
		}
		return { stdout: included(404, { message: `no fake for ${path}` }), code: 1 };
	};
	return { exec, calls };
}

const pull = {
	number: 32,
	title: "feat(pi-tag)",
	state: "open",
	merged: false,
	draft: false,
	user: { login: "AutumnsGrove" },
	head: { sha: "abc123", ref: "feat/pi-tag" },
	base: { ref: "main" },
};

describe("parseIncludedResponse", () => {
	it("reads a status line, headers, and a body", () => {
		const parsed = parseIncludedResponse(
			'HTTP/2.0 200 OK\r\nEtag: "x"\r\nX-Ratelimit-Remaining: 12\r\n\r\n{"a":1}'
		);
		expect(parsed.status).toBe(200);
		expect(parsed.headers.get("etag")).toBe('"x"');
		expect(parsed.headers.get("x-ratelimit-remaining")).toBe("12");
		expect(parsed.bodyText).toBe('{"a":1}');
	});

	it("survives an empty body and a missing header block", () => {
		expect(parseIncludedResponse("HTTP/2.0 304 Not Modified").status).toBe(304);
		expect(parseIncludedResponse("garbage").status).toBe(0);
	});
});

describe("retryDelayMs", () => {
	it("prefers retry-after, then a spent rate-limit reset", () => {
		expect(retryDelayMs(new Map([["retry-after", "7"]]))).toBe(7000);
		const reset = Math.floor(Date.now() / 1000) + 30;
		const delay = retryDelayMs(
			new Map([
				["x-ratelimit-remaining", "0"],
				["x-ratelimit-reset", String(reset)],
			])
		);
		expect(delay).toBeGreaterThan(25_000);
		expect(retryDelayMs(new Map())).toBeUndefined();
	});
});

describe("GhApi", () => {
	it("caches by ETag and serves a 304 from the cache", async () => {
		let count = 0;
		const exec: Exec = async () => {
			count += 1;
			return {
				stdout:
					count === 1
						? included(200, { number: 32 }, { Etag: '"abc"' })
						: included(304, undefined, { Etag: '"abc"' }),
				code: 0,
			};
		};
		const api = new GhApi({ exec, cwd: "/tmp" });
		const first = await api.get("repos/o/r/pulls/32", { etagKey: "pull" });
		expect(first.body).toEqual({ number: 32 });
		const second = await api.get("repos/o/r/pulls/32", { etagKey: "pull" });
		expect(second.notModified).toBe(true);
		expect(second.body).toEqual({ number: 32 });

		const conditional = await exec("gh", ["api", "--include", "-H", "If-None-Match: \"abc\"", "x"], {});
		expect(conditional.stdout).toContain("304");
	});

	it("classifies errors", async () => {
		const notFound = new GhApi({ exec: fakeExec([{ match: "pulls/1", reply: { status: 404, body: { message: "Not Found" } } }]).exec, cwd: "/tmp" });
		await expect(notFound.get("repos/o/r/pulls/1")).rejects.toMatchObject({ kind: "not-found", status: 404 });

		const limited = new GhApi({
			exec: fakeExec([
				{ match: "pulls/2", reply: { status: 403, body: { message: "API rate limit exceeded" }, headers: { "retry-after": "12" } } },
			]).exec,
			cwd: "/tmp",
		});
		await expect(limited.get("repos/o/r/pulls/2")).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 12_000 });

		const auth = new GhApi({
			exec: fakeExec([{ match: "pulls/3", reply: { status: 403, body: { message: "Resource not accessible by integration" } } }]).exec,
			cwd: "/tmp",
		});
		await expect(auth.get("repos/o/r/pulls/3")).rejects.toMatchObject({ kind: "auth" });

		const down = new GhApi({ exec: fakeExec([{ match: "pulls/4", reply: { status: 502, body: { message: "bad gateway" } } }]).exec, cwd: "/tmp" });
		await expect(down.get("repos/o/r/pulls/4")).rejects.toMatchObject({ kind: "server" });

		const offline = new GhApi({
			exec: async () => {
				throw new Error("spawn gh ENOENT");
			},
			cwd: "/tmp",
		});
		await expect(offline.get("repos/o/r/pulls/5")).rejects.toBeInstanceOf(GhApiError);
		await expect(offline.get("repos/o/r/pulls/5")).rejects.toMatchObject({ kind: "network" });
	});

	it("uses headers a throwing runner carried on its error", async () => {
		let count = 0;
		const exec: Exec = async () => {
			count += 1;
			if (count === 1) return { stdout: included(200, { number: 32 }, { Etag: '"abc"' }), code: 0 };
			throw Object.assign(new Error("gh: HTTP 304"), { stdout: included(304), stderr: "gh: HTTP 304" });
		};
		const api = new GhApi({ exec, cwd: "/tmp" });
		await api.get("repos/o/r/pulls/32", { etagKey: "pull" });
		await expect(api.get("repos/o/r/pulls/32", { etagKey: "pull" })).resolves.toMatchObject({
			status: 304,
			notModified: true,
			body: { number: 32 },
		});
	});

	it("does not serve a 304 it has nothing cached for", async () => {
		const api = new GhApi({ exec: fakeExec([{ match: "pulls/1", reply: { status: 304 } }]).exec, cwd: "/tmp" });
		await expect(api.get("repos/o/r/pulls/1", { etagKey: "pull" })).rejects.toMatchObject({ status: 304 });
	});
});

describe("snapshotPaths", () => {
	it("encodes the since watermark and asks for the newest comments", () => {
		const paths = snapshotPaths({ owner: "o", repo: "r", number: 7 }, "abc", { since: "2026-11-15T21:00:00Z" });
		expect(paths.checkRuns).toContain("/commits/abc/check-runs?per_page=100&filter=latest");
		expect(paths.issueComments).toContain("since=2026-11-15T21%3A00%3A00Z");
		expect(paths.reviewComments).toContain("direction=desc");
		expect(paths.reviews).toBe("repos/o/r/pulls/7/reviews?per_page=100");
	});
});

describe("fetchSnapshot", () => {
	it("reads the six resources and builds a snapshot", async () => {
		const fake = fakeExec([
			{ match: "/pulls/32/reviews", reply: { status: 200, body: [{ id: 5, state: "APPROVED", body: "" }] } },
			{ match: "pulls/32/comments", reply: { status: 200, body: [{ id: 11, body: "nit", path: "a.ts" }] } },
			{ match: "issues/32/comments", reply: { status: 200, body: [{ id: 10, body: "hi" }] } },
			{ match: "check-runs", reply: { status: 200, body: { check_runs: [{ id: 1, name: "review", status: "completed", conclusion: "success" }] } } },
			{ match: "/status", reply: { status: 200, body: { statuses: [] } } },
			{ match: "/pulls/32", reply: { status: 200, body: pull } },
		]);
		const api = new GhApi({ exec: fake.exec, cwd: "/tmp" });
		const snapshot = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		expect(snapshot.pull.number).toBe(32);
		expect(snapshot.checks).toHaveLength(1);
		expect(snapshot.comments.map((comment) => comment.id)).toEqual(["10", "11"]);
		expect(fake.calls).toHaveLength(6);
	});

	it("fails loudly when the PR payload has no head", async () => {
		const fake = fakeExec([{ match: "/pulls/1", reply: { status: 200, body: { number: 1 } } }]);
		const api = new GhApi({ exec: fake.exec, cwd: "/tmp" });
		await expect(fetchSnapshot(api, { owner: "o", repo: "r", number: 1 })).rejects.toMatchObject({
			message: expect.stringContaining("head SHA"),
		});
	});
});

describe("required checks", () => {
	it("reads branch protection, then rulesets, then gives up", async () => {
		const protection = new GhApi({
			exec: fakeExec([
				{ match: "required_status_checks", reply: { status: 200, body: { contexts: ["review"], checks: [{ context: "test" }] } } },
			]).exec,
			cwd: "/tmp",
		});
		expect(await requiredChecks(protection, { owner: "o", repo: "r", number: 1 }, "main")).toEqual(["review", "test"]);

		const rules = new GhApi({
			exec: fakeExec([
				{ match: "/protection/", reply: { status: 404, body: { message: "Branch not protected" } } },
				{ match: "/rules/branches/main", reply: { status: 200, body: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }] } },
			]).exec,
			cwd: "/tmp",
		});
		expect(await requiredChecks(rules, { owner: "o", repo: "r", number: 1 }, "main")).toEqual(["ci"]);

		const none = new GhApi({
			exec: fakeExec([
				{ match: "/protection/", reply: { status: 404, body: { message: "Branch not protected" } } },
				{ match: "/rules/branches/main", reply: { status: 200, body: [] } },
			]).exec,
			cwd: "/tmp",
		});
		expect(await requiredChecks(none, { owner: "o", repo: "r", number: 1 }, "main")).toBeUndefined();
	});

	it("parses contexts from both shapes, deduped", () => {
		expect(contextsFromProtection({ contexts: ["a", "a"], checks: [{ context: "b" }] })).toEqual(["a", "b"]);
		expect(contextsFromProtection({})).toBeUndefined();
		expect(contextsFromRules([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "a" }, { context: "a" }] } }])).toEqual(["a"]);
		expect(contextsFromRules("nope")).toBeUndefined();
	});
});

describe("pagination", () => {
	const link = (last: number, next?: number): string =>
		[
			...(next ? [`<https://api.github.com/x?per_page=100&page=${next}>; rel="next"`] : []),
			`<https://api.github.com/x?per_page=100&page=${last}>; rel="last"`,
		].join(", ");

	it("pages a seed to the newest issue comments", async () => {
		const fake = fakeExec([
			{ match: "/pulls/32/reviews", reply: { status: 200, body: [] } },
			{ match: "pulls/32/comments", reply: { status: 200, body: [] } },
			{ match: "issues/32/comments?per_page=100&page=2", reply: { status: 200, body: [{ id: 2, body: "newest" }] } },
			{
				match: "issues/32/comments",
				reply: { status: 200, body: [{ id: 1, body: "oldest" }], headers: { Link: link(2) } },
			},
			{ match: "check-runs", reply: { status: 200, body: { check_runs: [] } } },
			{ match: "/status", reply: { status: 200, body: { statuses: [] } } },
			{ match: "/pulls/32", reply: { status: 200, body: pull } },
		]);
		const api = new GhApi({ exec: fake.exec, cwd: "/tmp" });
		const snapshot = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		expect(snapshot.comments.map((comment) => comment.body)).toEqual(["newest"]);
		expect(fake.calls.some((args) => args.includes("repos/o/r/issues/32/comments?per_page=100&page=2"))).toBe(true);
	});

	it("follows next pages while polling with a watermark", async () => {
		const fake = fakeExec([
			{ match: "/pulls/32/reviews", reply: { status: 200, body: [] } },
			{ match: "pulls/32/comments", reply: { status: 200, body: [] } },
			{
				match: "since=2026-01-01T00%3A00%3A00Z&page=2",
				reply: { status: 200, body: [{ id: 2, body: "second page" }] },
			},
			{
				match: "issues/32/comments",
				reply: { status: 200, body: [{ id: 1, body: "first page" }], headers: { Link: link(2, 2) } },
			},
			{ match: "check-runs", reply: { status: 200, body: { check_runs: [] } } },
			{ match: "/status", reply: { status: 200, body: { statuses: [] } } },
			{ match: "/pulls/32", reply: { status: 200, body: pull } },
		]);
		const api = new GhApi({ exec: fake.exec, cwd: "/tmp" });
		const snapshot = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 }, { since: "2026-01-01T00:00:00Z" });
		expect(snapshot.comments.map((comment) => comment.body)).toEqual(["first page", "second page"]);
	});

	it("reads the newest review page, and keeps reading it on a 304", async () => {
		const reviews = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, state: "COMMENTED", body: "" }));
		const newest = [{ id: 101, state: "APPROVED", body: "ship it" }];
		let calls = 0;
		const exec: Exec = async (_command, args) => {
			calls += 1;
			const path = args.at(-1) ?? "";
			if (path.includes("reviews?per_page=100&page=2")) return { stdout: included(200, newest), code: 0 };
			if (path.includes("reviews?per_page=100&page=1")) {
				return { stdout: included(200, reviews, { Link: link(2, 2) }), code: 0 };
			}
			if (path.includes("reviews")) return { stdout: included(200, reviews, { Link: link(2, 2) }), code: 0 };
			if (path.includes("pulls/32/comments")) return { stdout: included(200, []), code: 0 };
			if (path.includes("issues/32/comments")) return { stdout: included(200, []), code: 0 };
			if (path.includes("check-runs")) return { stdout: included(200, { check_runs: [] }), code: 0 };
			if (path.includes("/status")) return { stdout: included(200, { statuses: [] }), code: 0 };
			return { stdout: included(200, pull), code: 0 };
		};
		const api = new GhApi({ exec, cwd: "/tmp" });
		const first = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		expect(first.reviews.map((review) => review.id)).toEqual(["101"]);

		// Page 2 has room, so the next poll reads exactly that page again.
		const before = calls;
		const second = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		expect(second.reviews.map((review) => review.id)).toEqual(["101"]);
		expect(calls - before).toBeGreaterThan(0);
	});

	it("does not replay pre-existing comments on a PR with more than one page", async () => {
		const oldest = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			body: `old ${index + 1}`,
			created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
		}));
		const newest = Array.from({ length: 50 }, (_, index) => ({
			id: index + 101,
			body: `new ${index + 101}`,
			created_at: new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString(),
		}));
		let sinceSeen: string | undefined;
		const exec: Exec = async (_command, args) => {
			const path = args.at(-1) ?? "";
			if (path.includes("issues/32/comments?per_page=100&page=2")) return { stdout: included(200, newest), code: 0 };
			if (path.includes("issues/32/comments")) {
				const since = /since=([^&]+)/.exec(path);
				sinceSeen = since?.[1] ? decodeURIComponent(since[1]) : undefined;
				if (sinceSeen) {
					// Nothing was updated after the newest seeded comment.
					return { stdout: included(200, []), code: 0 };
				}
				return { stdout: included(200, oldest, { Link: `<https://api.github.com/x?per_page=100&page=2>; rel="last"` }), code: 0 };
			}
			if (path.includes("reviews")) return { stdout: included(200, []), code: 0 };
			if (path.includes("pulls/32/comments")) return { stdout: included(200, []), code: 0 };
			if (path.includes("check-runs")) return { stdout: included(200, { check_runs: [] }), code: 0 };
			if (path.includes("/status")) return { stdout: included(200, { statuses: [] }), code: 0 };
			return { stdout: included(200, pull), code: 0 };
		};
		const api = new GhApi({ exec, cwd: "/tmp" });
		const seed = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		expect(seed.comments).toHaveLength(50);
		const cursor = initCursor(seed);
		expect(sinceSeen).toBeUndefined();

		const poll = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 }, { since: cursor.commentSince });
		expect(sinceSeen).toBe(cursor.commentSince);
		expect(diffSnapshot(poll, cursor).events).toEqual([]);
	});

	it("re-reads a full last page without a conditional, so a spill is not missed", async () => {
		const full = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, state: "COMMENTED", body: "" }));
		const requests: string[][] = [];
		let pageTwo: unknown[] = [];
		const exec: Exec = async (_command, args) => {
			requests.push(args);
			const path = args.at(-1) ?? "";
			if (path.includes("reviews?per_page=100&page=2")) return { stdout: included(200, pageTwo), code: 0 };
			if (path.includes("reviews")) return { stdout: included(200, full), code: 0 };
			if (path.includes("pulls/32/comments")) return { stdout: included(200, []), code: 0 };
			if (path.includes("issues/32/comments")) return { stdout: included(200, []), code: 0 };
			if (path.includes("check-runs")) return { stdout: included(200, { check_runs: [] }), code: 0 };
			if (path.includes("/status")) return { stdout: included(200, { statuses: [] }), code: 0 };
			return { stdout: included(200, pull), code: 0 };
		};
		const api = new GhApi({ exec, cwd: "/tmp" });
		await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		pageTwo = [{ id: 101, state: "APPROVED", body: "new page" }];
		const second = await fetchSnapshot(api, { owner: "o", repo: "r", number: 32 });
		expect(second.reviews.map((review) => review.id)).toEqual(["101"]);
		const reviewCalls = requests.filter((args) => (args.at(-1) ?? "").includes("/reviews"));
		expect(reviewCalls.every((args) => !args.includes("If-None-Match"))).toBe(true);
	});
});
