import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCursor } from "./diff.ts";
import type { Exec } from "./gh.ts";
import piPrSubscribe from "./index.ts";
import { resetPollers, tick } from "./poller.ts";
import {
	acquireLock,
	getRelease,
	getSubscription,
	listSubscriptions,
	registry,
	releaseLock,
	resetRegistry,
} from "./registry.ts";
import type { Snapshot } from "./snapshot.ts";

const ref = { owner: "AutumnsGrove", repo: "pi-extensions", number: 32 };

const included = (status: number, body: unknown): string =>
	`HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;

const pull = {
	number: 32,
	title: "feat(pi-tag): read the tree",
	state: "open",
	merged: false,
	draft: false,
	user: { login: "AutumnsGrove" },
	head: { sha: "aaa", ref: "feat/pi-tag" },
	base: { ref: "main" },
};

class FakeGh {
	checks: unknown[] = [];
	issueComments: unknown[] = [];
	auth = true;
	prView: string | null = JSON.stringify({ number: 32, url: "https://github.com/o/r/pull/32", state: "OPEN" });
	calls: string[] = [];

	exec: Exec = async (command, args) => {
		const key = [command, ...args].join(" ");
		this.calls.push(key);
		if (key === "git remote") return { stdout: "origin", code: 0 };
		if (key === "git remote get-url origin") return { stdout: "git@github.com:AutumnsGrove/pi-extensions.git", code: 0 };
		if (key === "gh auth status") return this.auth ? { stdout: "ok", code: 0 } : { stdout: "", code: 1 };
		if (key.startsWith("gh pr view")) return this.prView ? { stdout: this.prView, code: 0 } : { stdout: "", code: 1 };
		if (key.startsWith("gh api")) {
			const path = args.at(-1) ?? "";
			if (path.includes("/pulls/32/reviews")) return { stdout: included(200, []), code: 0 };
			if (path.includes("/pulls/32/comments")) return { stdout: included(200, []), code: 0 };
			if (path.includes("/issues/32/comments")) return { stdout: included(200, this.issueComments), code: 0 };
			if (path.includes("check-runs")) return { stdout: included(200, { check_runs: this.checks }), code: 0 };
			if (path.includes("/status?")) return { stdout: included(200, { statuses: [] }), code: 0 };
			if (path.includes("/rules/branches/")) return { stdout: included(200, []), code: 0 };
			if (path.includes("/protection/")) return { stdout: included(404, { message: "Branch not protected" }), code: 1 };
			if (path.includes("/pulls/32")) return { stdout: included(200, pull), code: 0 };
		}
		return { stdout: "", code: 1 };
	};

	snapshot(): Snapshot {
		return {
			pull: { number: 32, title: String(pull.title), url: "u", state: "open", merged: false, draft: false, headSha: "aaa", headRef: "feat/pi-tag", baseRef: "main", authorBot: false },
			checks: [],
			comments: [],
			reviews: [],
		};
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	pi: ExtensionAPI;
	server: FakeGh;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }> }>;
	handlers: Map<string, Handler[]>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	messages: Array<{ customType: string; content: string; display?: boolean }>;
	notifications: string[];
	widgets: Array<{ key: string; content: unknown }>;
	entries: Array<{ type: string; customType?: string; data?: unknown }>;
	/** Hook events emitted through `pi-hooks:emit`. */
	hookEvents: Array<{ event: string; input: Record<string, unknown> }>;
	ctx: ExtensionContext;
	emit: (name: string, event: unknown) => Promise<void>;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-pr-subscribe-index-"));
	process.env.PI_PR_SUBSCRIBE_STATE_DIR = dir;
	process.env.PI_PR_POLL = "1";
	resetRegistry();
	resetPollers();
	vi.useFakeTimers();
});

afterEach(() => {
	for (const sub of listSubscriptions()) {
		if (sub.timer) clearTimeout(sub.timer);
		if (sub.flushTimer) clearTimeout(sub.flushTimer);
	}
	resetRegistry();
	resetPollers();
	vi.useRealTimers();
	delete process.env.PI_PR_SUBSCRIBE_STATE_DIR;
	delete process.env.PI_PR_POLL;
	rmSync(dir, { recursive: true, force: true });
});

function load(options: { entries?: unknown[] } = {}): Harness {
	const server = new FakeGh();
	const tools = new Map<string, Harness["tools"] extends Map<string, infer T> ? T : never>();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: Harness["messages"] = [];
	const notifications: string[] = [];
	const widgets: Harness["widgets"] = [];
	const hookEvents: Harness["hookEvents"] = [];
	const entries: Harness["entries"] = [
		...(options.entries ?? []) as Harness["entries"],
	];

	const pi = {
		registerTool: (definition: { name: string }) => {
			tools.set(definition.name, definition as never);
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, definition);
		},
		on: (name: string, handler: Handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage: (message: { customType: string; content: string; display?: boolean }) => {
			messages.push(message);
		},
		exec: server.exec,
		getFlag: () => undefined,
		getSettings: () => ({}),
		events: {
			emit(channel: string, data: unknown) {
				if (channel !== "pi-hooks:emit") return;
				const emission = data as { event: string; input: Record<string, unknown> };
				hookEvents.push(emission);
			},
			on: () => () => {},
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp/project",
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => entries,
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify: (message: string) => notifications.push(message),
			setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
		},
	} as unknown as ExtensionContext;

	piPrSubscribe(pi);

	return {
		pi,
		server,
		tools,
		handlers,
		commands,
		messages,
		notifications,
		widgets,
		entries,
		hookEvents,
		ctx,
		async emit(name: string, event: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

const tool = (h: Harness, name: string) => {
	const found = h.tools.get(name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
};

const call = (h: Harness, name: string, params: Record<string, unknown> = {}) =>
	tool(h, name).execute("call-1", params, undefined, undefined, h.ctx);

describe("subscribe_pr_activity", () => {
	it("defaults to origin and the branch's PR, and returns the rules", async () => {
		const h = load();
		const result = await call(h, "subscribe_pr_activity");
		expect(result.content[0]?.text).toContain("Subscribed to AutumnsGrove/pi-extensions#32");
		expect(result.content[0]?.text).toContain("untrusted GitHub data");
		expect(getSubscription(ref)).toBeDefined();
		expect(h.widgets.length).toBeGreaterThan(0);
		expect(result.details).toMatchObject({ owner: "AutumnsGrove", repo: "pi-extensions", number: 32, subscribed: true });
	});

	it("is idempotent", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const second = await call(h, "subscribe_pr_activity");
		expect(second.content[0]?.text).toContain("Already subscribed");
		expect(listSubscriptions("session-1")).toHaveLength(1);
	});

	it("refuses a repository that is not a git remote", async () => {
		const h = load();
		const result = await call(h, "subscribe_pr_activity", { owner: "evil", repo: "x", pullNumber: 1 });
		expect(result.content[0]?.text).toContain("is not a remote of this repository");
		expect(result.details).toMatchObject({ subscribed: false });
		expect(listSubscriptions()).toHaveLength(0);
	});

	it("explains missing gh auth instead of subscribing silently", async () => {
		const h = load();
		h.server.auth = false;
		const result = await call(h, "subscribe_pr_activity");
		expect(result.content[0]?.text).toContain("gh auth login");
		expect(listSubscriptions()).toHaveLength(0);
	});

	it("reports a PR that cannot be read", async () => {
		const h = load();
		h.server.prView = null;
		const result = await call(h, "subscribe_pr_activity");
		expect(result.content[0]?.text).toContain("No open pull request");
	});

	it("unsubscribes, and is idempotent about it", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const first = await call(h, "unsubscribe_pr_activity");
		expect(first.content[0]?.text).toContain("Unsubscribed");
		expect(getSubscription(ref)).toBeUndefined();
		const second = await call(h, "unsubscribe_pr_activity");
		expect(second.content[0]?.text).toContain("Already unsubscribed");
		expect(second.details).toMatchObject({ released: false, done: false, alreadyReleased: true });
	});

	it("records a done release with its reason", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const result = await call(h, "unsubscribe_pr_activity", {
			done: true,
			reason: "green,  reviews   addressed",
		});
		expect(result.content[0]?.text).toContain("Released AutumnsGrove/pi-extensions#32 as done");
		expect(result.content[0]?.text).toContain("green, reviews addressed");
		expect(result.details).toMatchObject({ released: true, done: true });
		const release = getRelease(ref);
		expect(release).toMatchObject({ done: true, reason: "green, reviews addressed" });

		const command = h.commands.get("subscribe");
		if (!command) throw new Error("missing command");
		await command.handler("status", h.ctx);
		expect(h.notifications.at(-1)).toContain("AutumnsGrove/pi-extensions#32 — done");
		expect(h.notifications.at(-1)).toContain("green, reviews addressed");
	});

	it("records a plain unsubscribe as not done", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const result = await call(h, "unsubscribe_pr_activity");
		expect(result.details).toMatchObject({ released: true, done: false });
		expect(getRelease(ref)).toMatchObject({ done: false });
	});

	it("does not claim a done release it did not record", async () => {
		const h = load();
		const result = await call(h, "unsubscribe_pr_activity", { done: true, reason: "green" });
		expect(result.content[0]?.text).toContain("Not subscribed");
		expect(result.details).toMatchObject({ released: false, done: false });
		expect(getRelease(ref)).toBeUndefined();
	});

	it("does not record a release for a PR it was not watching", async () => {
		const h = load();
		const result = await call(h, "unsubscribe_pr_activity");
		expect(result.content[0]?.text).toContain("Not subscribed");
		expect(result.details).toMatchObject({ released: false });
		expect(getRelease(ref)).toBeUndefined();
	});

	it("answers a done release after a merge ended the watch, instead of failing", async () => {
		// The shape of the bug this guards: the merge ends the watch, then the agent
		// calls done: true and used to get "Not subscribed" — or, with a registry
		// left behind by an older module instance, a thrown TypeError.
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		Object.assign(pull, { state: "closed", merged: true });
		try {
			await tick(sub, { cwd: "/tmp/project", basePollMs: 20_000, coalesceMs: 0, now: () => Date.now() });
		} finally {
			Object.assign(pull, { state: "open", merged: false });
		}
		expect(getSubscription(ref)).toBeUndefined();

		const result = await call(h, "unsubscribe_pr_activity", { done: true, reason: "green, reviews addressed" });
		expect(result.content[0]?.text).toContain("is no longer watched");
		expect(result.content[0]?.text).toContain("merged");
		expect(result.content[0]?.text).toContain("A done release was not recorded");
		expect(result.details).toMatchObject({ released: false, done: false, alreadyReleased: true });
		expect(getRelease(ref)).toMatchObject({ done: false, reason: "merged" });
		expect(h.hookEvents.filter((event) => event.event === "PrReadyToMerge")).toEqual([]);
	});

	it("does not throw when the watch stopped but the release cannot be recorded", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		// A registry the write cannot reach. The watch must still stop, and the
		// result must say what did and did not happen — in the details too, which
		// consumers forward as `tool_response.details`.
		registry().releases = {} as never;
		const result = await call(h, "unsubscribe_pr_activity", { done: true, reason: "green" });
		expect(result.content[0]?.text).toContain("Unsubscribed from AutumnsGrove/pi-extensions#32");
		expect(result.content[0]?.text).toContain("could not be recorded");
		expect(result.details).toMatchObject({ released: false, done: false });
		expect(result.details).not.toHaveProperty("reason");
		expect(result.details).not.toHaveProperty("alreadyReleased");
		expect(getSubscription(ref)).toBeUndefined();
		expect(h.hookEvents).toEqual([]);
	});

	it("reports a done release to the hooks bus, and a plain one not at all", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await call(h, "unsubscribe_pr_activity", { done: true, reason: "green, reviews addressed" });
		expect(h.hookEvents).toEqual([
			{
				event: "PrReadyToMerge",
				input: {
					owner: "AutumnsGrove",
					repo: "pi-extensions",
					pullNumber: 32,
					reason: "green, reviews addressed",
				},
			},
		]);

		const plain = load();
		await call(plain, "subscribe_pr_activity");
		await call(plain, "unsubscribe_pr_activity");
		expect(plain.hookEvents).toEqual([]);
	});

	it("does not report a merge or `/subscribe off` as ready to merge", async () => {
		const off = load();
		await call(off, "subscribe_pr_activity");
		const command = off.commands.get("subscribe");
		if (!command) throw new Error("missing command");
		await command.handler("off 32", off.ctx);
		expect(off.hookEvents).toEqual([]);

		// A merge ends the watch through the poller, never through the tool.
		const merged = load();
		await call(merged, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		Object.assign(pull, { state: "closed", merged: true });
		try {
			await tick(sub, { cwd: "/tmp/project", basePollMs: 20_000, coalesceMs: 0, now: () => Date.now() });
		} finally {
			Object.assign(pull, { state: "open", merged: false });
		}
		expect(sub.ended).toBe(true);
		expect(merged.hookEvents.filter((event) => event.event === "PrReadyToMerge")).toEqual([]);
	});
});

describe("expiry", () => {
	it("keeps an expired watch paused and resumes it with a catch-up", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		sub.expiredAt = Date.now();
		sub.catchUp = false;
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		sub.paused = true;
		// Expiry releases the lock, as `expire()` does.
		releaseLock(sub.lock);
		sub.lock = undefined;

		const resumed = await call(h, "subscribe_pr_activity");
		expect(resumed.content[0]?.text).toContain("Resumed AutumnsGrove/pi-extensions#32");
		expect(sub.expiredAt).toBeUndefined();
		expect(sub.catchUp).toBe(true);
		expect(sub.paused).toBe(false);
		expect(sub.timer).toBeDefined();
	});

	it("leaves an expired watch alone on reload", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		sub.expiredAt = Date.now();
		sub.paused = true;
		await h.emit("session_start", { type: "session_start", reason: "reload" });
		expect(sub.paused).toBe(true);
		expect(sub.timer).toBeUndefined();
	});

	it("does not re-arm an expired watch through the blocked retry loop", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		releaseLock(sub.lock);
		sub.lock = undefined;
		sub.expiredAt = Date.now();
		sub.paused = true;
		sub.blockedBy = "another session";
		await h.emit("session_start", { type: "session_start", reason: "startup" });
		// The UI ticker retries blocked subscriptions once a minute.
		vi.advanceTimersByTime(120_000);
		expect(sub.paused).toBe(true);
		expect(sub.timer).toBeUndefined();
		expect(sub.expiredAt).toBeDefined();
		expect(sub.lock).toBeUndefined();
	});

	it("keeps an expired watch expired when a resume cannot take the lock", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		// Another live session holds the PR, so the resume cannot take it.
		releaseLock(sub.lock);
		sub.lock = undefined;
		const held = acquireLock(ref, "session-2");
		if (!held.ok) throw new Error("expected the other session to take the lock");
		sub.expiredAt = Date.now();
		sub.paused = true;

		const resumed = await call(h, "subscribe_pr_activity");
		expect(resumed.content[0]?.text).toContain("is expired here");
		expect(resumed.content[0]?.text).toContain("run /subscribe 32 to try again");
		expect(resumed.details).toMatchObject({ subscribed: false });
		// Truthful state: still expired, not "blocked", and not polling.
		expect(sub.expiredAt).toBeDefined();
		expect(sub.blockedBy).toBeUndefined();
		expect(sub.paused).toBe(true);
		expect(sub.timer).toBeUndefined();
		releaseLock(held.lock);
	});

	it("restores an expired watch without polling it", async () => {
		const cursor = initCursor(new FakeGh().snapshot());
		const h = load({
			entries: [
				{
					type: "custom",
					customType: "pi-pr-subscribe",
					data: {
						subscriptions: [
							{
								owner: "AutumnsGrove",
								repo: "pi-extensions",
								number: 32,
								cursor,
								cwd: "/tmp/project",
								sessionId: "session-1",
								createdAt: 1,
								expiredAt: 2,
							},
						],
					},
				},
			],
		});
		await h.emit("session_start", { type: "session_start", reason: "startup" });
		const sub = getSubscription(ref);
		expect(sub?.expiredAt).toBe(2);
		expect(sub?.timer).toBeUndefined();
		expect(sub?.lock).toBeUndefined();
	});
});

describe("/subscribe", () => {
	it("lists subscriptions and their status", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const command = h.commands.get("subscribe");
		if (!command) throw new Error("missing command");
		await command.handler("list", h.ctx);
		expect(h.notifications.at(-1)).toContain("AutumnsGrove/pi-extensions#32");

		await command.handler("status", h.ctx);
		expect(h.notifications.at(-1)).toContain("head aaa");
	});

	it("stops a subscription", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const command = h.commands.get("subscribe");
		if (!command) throw new Error("missing command");
		await command.handler("off 32", h.ctx);
		expect(h.notifications.at(-1)).toContain("Unsubscribed");
		expect(listSubscriptions()).toHaveLength(0);
	});

	it("says when nothing is subscribed", async () => {
		const h = load();
		const command = h.commands.get("subscribe");
		if (!command) throw new Error("missing command");
		await command.handler("", h.ctx);
		expect(h.notifications.at(-1)).toContain("No pull requests subscribed");
	});
});

describe("own comments", () => {
	it("records the id a gh command printed", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await h.emit("tool_result", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "gh pr comment 32 --body 'on it'" },
			content: [{ type: "text", text: "https://github.com/o/r/pull/32#issuecomment-3550000001" }],
			isError: false,
		});
		const sub = getSubscription(ref);
		expect(sub?.cursor.ownIds).toContain("3550000001");
		expect(sub?.cursor.commentIds).toContain("3550000001");
	});

	it("records when the session posted, even when the output carries no id", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await h.emit("tool_result", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "gh pr comment 32 --body-file /tmp/reply.md" },
			content: [{ type: "text", text: "posted" }],
			isError: false,
		});
		// No id to capture, so the timestamp is what lets the poller recognise the
		// comment the command created.
		const sub = getSubscription(ref);
		expect(sub?.ownPostAt).toBeTypeOf("number");
		expect(sub?.cursor.ownIds).toEqual([]);
	});

	it("does not record a post for a command that is not a gh write", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await h.emit("tool_result", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "gh pr view 32 --json state" },
			content: [{ type: "text", text: "OPEN" }],
			isError: false,
		});
		expect(getSubscription(ref)?.ownPostAt).toBeUndefined();
	});

	it("ignores a failed command and an unrelated PR", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await h.emit("tool_result", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "gh pr comment 32 --body 'on it'" },
			content: [{ type: "text", text: "#issuecomment-1" }],
			isError: true,
		});
		await h.emit("tool_result", {
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "gh pr comment 99 --body 'other'" },
			content: [{ type: "text", text: "#issuecomment-2" }],
			isError: false,
		});
		expect(getSubscription(ref)?.cursor.ownIds).toEqual([]);
	});
});

describe("session lifecycle", () => {
	it("restores a subscription from the session branch with a catch-up", async () => {
		const cursor = initCursor(new FakeGh().snapshot());
		const h = load({
			entries: [
				{
					type: "custom",
					customType: "pi-pr-subscribe",
					data: {
						subscriptions: [
							{
								owner: "AutumnsGrove",
								repo: "pi-extensions",
								number: 32,
								cursor,
								cwd: "/tmp/project",
								sessionId: "session-1",
								createdAt: 1,
							},
						],
					},
				},
			],
		});
		await h.emit("session_start", { type: "session_start", reason: "startup" });
		const sub = getSubscription(ref);
		expect(sub).toBeDefined();
		expect(sub?.catchUp).toBe(true);
	});

	it("re-arms a running poller on reload", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		// Simulate a poller that was interrupted mid-request: no timer, not ended.
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		sub.paused = true;
		await h.emit("session_start", { type: "session_start", reason: "reload" });
		expect(sub.paused).toBe(false);
		expect(sub.timer).toBeDefined();
	});

	it("leaves a blocked subscription to the retry loop on reload", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		const sub = getSubscription(ref);
		if (!sub) throw new Error("expected a subscription");
		sub.lock = undefined;
		sub.blockedBy = "another session";
		if (sub.timer) clearTimeout(sub.timer);
		sub.timer = undefined;
		sub.paused = true;
		await h.emit("session_start", { type: "session_start", reason: "reload" });
		expect(sub.paused).toBe(true);
		expect(sub.timer).toBeUndefined();
	});

	it("reminds a compacted session what it is watching", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await h.emit("session_compact", { type: "session_compact" });
		const reminder = h.messages.at(-1);
		expect(reminder?.content).toContain("still subscribed");
		expect(reminder?.display).toBe(false);
	});

	it("drops subscriptions on quit", async () => {
		const h = load();
		await call(h, "subscribe_pr_activity");
		await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(listSubscriptions()).toHaveLength(0);
		expect(registry().subs.size).toBe(0);
	});
});
