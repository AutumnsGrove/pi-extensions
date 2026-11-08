import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piReview from "./index.ts";
import { runLocalReview } from "./local.ts";

vi.mock("./local.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./local.ts")>();
	return { ...actual, runLocalReview: vi.fn() };
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface Harness {
	command: { name: string; handler: Handler; getArgumentCompletions?: (prefix: string) => unknown };
	tools: ToolDefinition[];
	handlers: Map<string, (...args: unknown[]) => unknown>;
	notify: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	ctx: ExtensionCommandContext;
}

function load(
	exec: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> = async () => ({
		stdout: "",
		stderr: "",
		code: 1,
	})
): Harness {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const notify = vi.fn();
	const sendMessage = vi.fn();
	let command: Harness["command"] | undefined;
	const pi = {
		registerCommand: (name: string, options: Omit<Harness["command"], "name">) => {
			command = { name, ...options };
		},
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		exec,
		sendMessage,
	} as unknown as Parameters<typeof piReview>[0];
	piReview(pi);
	if (!command) throw new Error("pi-review did not register a command");
	const ctx = {
		cwd: "/repo",
		model: undefined,
		thinkingLevel: "medium",
		isProjectTrusted: () => true,
		ui: {
			notify,
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
	return { command, tools, handlers, notify, sendMessage, ctx };
}

const original = process.env.PI_REVIEW;

beforeEach(() => {
	vi.mocked(runLocalReview).mockReset();
});

afterEach(() => {
	if (original === undefined) delete process.env.PI_REVIEW;
	else process.env.PI_REVIEW = original;
});

describe("pi-review command", () => {
	it("registers the command and stays out of runner mode by default", () => {
		delete process.env.PI_REVIEW;
		const { command, tools } = load();
		expect(command.name).toBe("pi-review");
		expect(tools).toEqual([]);
	});

	it("registers submit_review in runner mode", () => {
		process.env.PI_REVIEW = "1";
		const { tools } = load();
		expect(tools.map((tool) => tool.name)).toEqual(["submit_review"]);
	});

	it("shows help with no arguments", async () => {
		delete process.env.PI_REVIEW;
		const { command, sendMessage, ctx } = load();
		await command.handler("", ctx);
		const message = sendMessage.mock.calls[0]![0] as { content: string; customType: string };
		expect(message.customType).toBe("pi-review");
		expect(message.content).toContain("## pi-review");
		expect(message.content).toContain("`/pi-review run");
	});

	it("points at install when settings has no file yet", async () => {
		delete process.env.PI_REVIEW;
		const { command, notify, ctx } = load();
		await command.handler("settings", ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("not installed here"),
			"info"
		);
	});

	it("reports an uninstall preflight failure instead of throwing", async () => {
		delete process.env.PI_REVIEW;
		const { command, notify, ctx } = load();
		await command.handler("uninstall", ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Not a github.com checkout"),
			"error"
		);
	});

	it("reports an install preflight failure instead of throwing", async () => {
		delete process.env.PI_REVIEW;
		const { command, notify, ctx } = load();
		await command.handler("install", ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Not a github.com checkout"),
			"error"
		);
	});

	it("rejects an unknown subcommand", async () => {
		delete process.env.PI_REVIEW;
		const { command, notify, ctx } = load();
		await command.handler("nope", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("unknown subcommand"), "error");
	});

	it("does not surface a stale ctx after a reload", async () => {
		delete process.env.PI_REVIEW;
		const { command, ctx } = load();
		vi.mocked(ctx.ui.notify).mockImplementation(() => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx."
			);
		});
		await expect(command.handler("uninstall", ctx)).resolves.toBeUndefined();
	});

	it("aborts in-flight work when the session shuts down", async () => {
		delete process.env.PI_REVIEW;
		let received: AbortSignal | undefined;
		vi.mocked(runLocalReview).mockImplementation(
			(options) =>
				new Promise((_resolve, reject) => {
					received = options.signal;
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				})
		);
		const { command, handlers, ctx } = load(async (name, args) =>
			name === "git" && args.join(" ") === "remote get-url origin"
				? { stdout: "git@github.com:owner/repo.git", stderr: "", code: 0 }
				: { stdout: "", stderr: "", code: 1 }
		);
		const pending = command.handler("run --pr 7", ctx);
		await vi.waitFor(() => expect(received).toBeDefined());
		handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" });
		await expect(pending).resolves.toBeUndefined();
		expect(received?.aborted).toBe(true);
	});

	it("passes the resolved PR and base to the child process", async () => {
		delete process.env.PI_REVIEW;
		vi.mocked(runLocalReview).mockResolvedValue({
			code: 0,
			timedOut: false,
			aborted: false,
			stdout: "",
			stderr: "",
			text: "",
			toolCalls: ["submit_review"],
			review: { event: "COMMENT", summary: "Fine.", comments: [], dropped: [] },
		});
		const { command, ctx } = load();
		await command.handler("run --pr 7 --base release", ctx);
		expect(runLocalReview).toHaveBeenCalledWith(
			expect.objectContaining({
				dryRun: true,
				env: { PR_NUMBER: "7", PI_REVIEW_BASE_REF: "release" },
				tools: ["read", "grep", "find", "ls", "submit_review"],
			})
		);
	});

	it("warns when the checkout is not the pull request head", async () => {
		delete process.env.PI_REVIEW;
		vi.mocked(runLocalReview).mockResolvedValue({
			code: 0,
			timedOut: false,
			aborted: false,
			stdout: "",
			stderr: "",
			text: "",
			toolCalls: ["submit_review"],
			review: { event: "COMMENT", summary: "Fine.", comments: [], dropped: [] },
		});
		const { command, notify, ctx } = load(async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			if (key === "git remote get-url origin") {
				return { stdout: "git@github.com:owner/repo.git", stderr: "", code: 0 };
			}
			if (key === "git rev-parse HEAD") return { stdout: "local-sha", stderr: "", code: 0 };
			if (key === "gh pr view 7 --json headRefOid --jq .headRefOid") {
				return { stdout: "pr-head-sha", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 1 };
		});
		await command.handler("run --pr 7", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("file reads may not match"), "warning");
	});

	it("refuses --post without a pull request", async () => {
		delete process.env.PI_REVIEW;
		const { command, notify, ctx } = load(async (command, args) =>
			command === "git" && args[0] === "remote"
				? { stdout: "git@github.com:owner/repo.git", stderr: "", code: 0 }
				: { stdout: "", stderr: "", code: 1 }
		);
		await command.handler("run --post", ctx);
		expect(runLocalReview).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("--post needs a pull request"), "error");
	});

	it("suggests subcommands for completion", () => {
		delete process.env.PI_REVIEW;
		const { command } = load();
		const items = command.getArgumentCompletions?.("st") as { value: string }[];
		expect(items.map((item) => item.value)).toEqual(["status"]);
		expect(command.getArgumentCompletions?.("zzz")).toBeNull();
	});
});
