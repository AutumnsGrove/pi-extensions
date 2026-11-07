import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "./detect.ts";
import type { CommandRunner } from "./github/exec.ts";
import type { FetchLike } from "./github/app.ts";
import type { BranchOptions, BranchResult } from "./github/git.ts";
import type { ManifestServer, ManifestServerOptions } from "./github/server.ts";
import { ManifestTimeoutError } from "./github/server.ts";
import { APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE } from "./github/secrets.ts";
import { API_KEY_SECRET, installPiReview, renderInstallOutcome, type WizardUI } from "./install.ts";
import { defaultSettings, parseSettings } from "./settings.ts";

const CREATE = "Create a Pi GitHub App (recommended)";
const REUSE = "Reuse the Pi GitHub App on this repository";
const EXISTING = "Use an existing Pi GitHub App (App ID + key file)";
const TOKEN = "Use GITHUB_TOKEN instead (no App)";

// A real key: the create path signs a JWT to verify the installation.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const repo = { owner: "owner", repo: "repo" };
const harnessDirs: string[] = [];

afterEach(async () => {
	await Promise.all(harnessDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Per-test cache/key dirs so no test touches the real pi agent directory. */
function harnessDirsFor(): { dir: string; cachePath: string; keyDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-review-harness-"));
	harnessDirs.push(dir);
	return { dir, cachePath: join(dir, "pi-review.json"), keyDir: join(dir, "keys") };
}
const cwd = "/repo";
const defaults = { provider: "opencode-go", model: "deepseek-v4.1-flash" as const };
const env = { PI_REVIEW_PACKAGE_REF: "abc123" };

type Answer<T> = T | (() => T);

function scriptedUi(script: {
	confirm?: Answer<boolean>[];
	select?: Answer<string | undefined>[];
	input?: Answer<string | undefined>[];
}): WizardUI & {
	notifications: { message: string; type?: string }[];
	prompts: string[];
	selects: { title: string; options: string[] }[];
} {
	const confirms = [...(script.confirm ?? [])];
	const selectQueue = [...(script.select ?? [])];
	const inputs = [...(script.input ?? [])];
	const notifications: { message: string; type?: string }[] = [];
	const prompts: string[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const take = <T>(queue: Answer<T>[], kind: string): T => {
		if (queue.length === 0) throw new Error(`no scripted ${kind} answer left`);
		const next = queue.shift()!;
		return typeof next === "function" ? (next as () => T)() : next;
	};
	return {
		notifications,
		prompts,
		selects,
		async confirm(title) {
			prompts.push(title);
			return take(confirms, "confirm");
		},
		async select(title, options) {
			prompts.push(title);
			selects.push({ title, options });
			return take(selectQueue, "select");
		},
		async input(title) {
			prompts.push(title);
			return take(inputs, "input");
		},
		notify(message, type) {
			notifications.push({ message, ...(type ? { type } : {}) });
		},
	};
}

function fakeExec(extra: Record<string, { stdout?: string; code?: number }> = {}): Exec {
	const responses: Record<string, { stdout?: string; code?: number }> = {
		"git remote get-url origin": { stdout: "git@github.com:owner/repo.git" },
		"gh auth status": { stdout: "ok" },
		"gh api repos/owner/repo --jq .permissions.admin": { stdout: "true" },
		"gh api repos/owner/repo --jq .default_branch": { stdout: "main" },
		"gh api user --jq .login": { stdout: "me" },
		"gh api users/owner --jq .type": { stdout: "User" },
		"pi --version": { stdout: "1.5.0" },
		...extra,
	};
	return async (command, args) => {
		const hit = responses[`${command} ${args.join(" ")}`];
		if (!hit) return { stdout: "", stderr: "not found", code: 1 };
		return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
	};
}

interface RunnerCall {
	args: string[];
	stdin?: string;
}

function fakeRunner(
	options: { secrets?: string[]; slug?: string; failOn?: string } = {}
): CommandRunner & { calls: RunnerCall[] } {
	const calls: RunnerCall[] = [];
	const runner = (async (_command: string, args: string[], opts: { stdin?: string }) => {
		calls.push({ args, ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }) });
		if (args[0] === "secret" && args[1] === "set") {
			if (options.failOn && args[2] === options.failOn) {
				return { stdout: "", stderr: "HTTP 403: forbidden", code: 1 };
			}
			return { stdout: "", stderr: "", code: 0 };
		}
		if (args[0] === "secret" && args[1] === "delete") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "variable" && args[1] === "get") {
			return options.slug
				? { stdout: `${options.slug}\n`, stderr: "", code: 0 }
				: { stdout: "", stderr: "not found", code: 1 };
		}
		if (args[0] === "variable" && (args[1] === "set" || args[1] === "delete")) {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (args[0] === "api" && args[1]?.includes("/actions/secrets")) {
			const secrets = options.secrets ?? [API_KEY_SECRET];
			return {
				stdout: secrets.length > 0 ? `${secrets.join("\n")}\n` : "",
				stderr: "",
				code: 0,
			};
		}
		return { stdout: "", stderr: "unexpected", code: 1 };
	}) as CommandRunner;
	return Object.assign(runner, { calls });
}

function fakeServerFactory(behavior: { code?: string; error?: Error } = {}): {
	factory: (options: ManifestServerOptions) => Promise<ManifestServer>;
	started: ManifestServerOptions[];
	closes: { count: number };
} {
	const started: ManifestServerOptions[] = [];
	const closes = { count: 0 };
	const factory = async (options: ManifestServerOptions): Promise<ManifestServer> => {
		started.push(options);
		return {
			startUrl: "http://127.0.0.1:9999/",
			redirectUrl: "http://127.0.0.1:9999/callback",
			waitForCode: behavior.error
				? Promise.reject(behavior.error)
				: Promise.resolve(behavior.code ?? "CODE-1"),
			close: async () => {
				closes.count += 1;
			},
		};
	};
	return { factory, started, closes };
}

function fakeFetch(app: Record<string, unknown> = { id: 1234, slug: "pi-review-x", name: "Pi Review" }) {
	const calls: string[] = [];
	const fetchImpl = async (url: string) => {
		calls.push(url);
		return {
			ok: true,
			status: 201,
			text: async () => JSON.stringify({ ...app, pem }),
		};
	};
	return Object.assign(fetchImpl, { calls });
}

function fakeBranchWriter(): {
	writeBranch: (options: BranchOptions) => Promise<BranchResult>;
	calls: BranchOptions[];
} {
	const calls: BranchOptions[] = [];
	const writeBranch = async (options: BranchOptions): Promise<BranchResult> => {
		calls.push(options);
		return {
			branch: "pi-review/setup",
			compareUrl: `https://github.com/owner/repo/compare/${options.defaultBranch}...pi-review/setup?expand=1`,
			committed: true,
			pushed: true,
			restoredBranch: "main",
			files: options.files.map((file) => file.path),
		};
	};
	return { writeBranch, calls };
}

interface HarnessOptions {
	exec?: Exec;
	runner?: ReturnType<typeof fakeRunner>;
	ui?: WizardUI;
	server?: ReturnType<typeof fakeServerFactory>;
	waitForInstallation?: () => Promise<{ id: number } | undefined>;
	writeBranch?: ReturnType<typeof fakeBranchWriter>;
	opened?: string[];
	defaults?: { provider?: string; model?: string };
	authorizeOpenCode?: () => Promise<string>;
	authorizeOpenRouter?: (options: { keyLabel: string }) => Promise<string>;
	fetch?: ReturnType<typeof fakeFetch>;
	cachePath?: string;
	keyDir?: string;
	saveAppKeyLocally?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const runner = options.runner ?? fakeRunner();
	const server = options.server ?? fakeServerFactory();
	const writer = options.writeBranch ?? fakeBranchWriter();
	const opened = options.opened ?? [];
	const ui = options.ui ?? scriptedUi({ confirm: [true, true], select: [CREATE, "medium", "Read-only (read, grep, find, ls)", "Comment only (recommended)"] });
	const safe = harnessDirsFor();
	return {
		runner,
		server,
		writer,
		opened,
		ui,
		run: () =>
			installPiReview({
				cwd,
				env,
				ui,
				defaults: options.defaults ?? defaults,
				deps: {
					exec: options.exec ?? fakeExec(),
					run: runner,
					startServer: server.factory,
					openUrl: async (url) => {
						opened.push(url);
						return true;
					},
					fetch: options.fetch ?? fakeFetch(),
					waitForInstallation: options.waitForInstallation ?? (async () => ({ id: 9 })),
					saveAppKeyLocally: options.saveAppKeyLocally ?? false,
					cachePath: options.cachePath ?? safe.cachePath,
					keyDir: options.keyDir ?? safe.keyDir,
					writeBranch: writer.writeBranch,
					...(options.authorizeOpenCode ? { authorizeOpenCode: options.authorizeOpenCode as never } : {}),
					...(options.authorizeOpenRouter
						? { authorizeOpenRouter: options.authorizeOpenRouter as never }
						: {}),
				},
			}),
	};
}

describe("installPiReview preflight", () => {
	it("refuses a checkout without a github.com remote", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "", code: 1 });
		await expect(
			installPiReview({
				cwd,
				env,
				ui: scriptedUi({}),
				deps: { exec, run: fakeRunner(), writeBranch: fakeBranchWriter().writeBranch },
			})
		).rejects.toThrow("Not a github.com checkout");
	});

	it("refuses when gh is not authenticated", async () => {
		const exec = fakeExec({ "gh auth status": { code: 1 } });
		await expect(
			installPiReview({
				cwd,
				env,
				ui: scriptedUi({}),
				deps: { exec, run: fakeRunner(), writeBranch: fakeBranchWriter().writeBranch },
			})
		).rejects.toThrow("gh auth login");
	});

	it("refuses without repository admin", async () => {
		const exec = fakeExec({ "gh api repos/owner/repo --jq .permissions.admin": { stdout: "false" } });
		await expect(
			installPiReview({
				cwd,
				env,
				ui: scriptedUi({}),
				deps: { exec, run: fakeRunner(), writeBranch: fakeBranchWriter().writeBranch },
			})
		).rejects.toThrow("Repository admin is required");
	});
});

describe("installPiReview identity choices", () => {
	it("aborts cleanly when the plan is declined", async () => {
		const ui = scriptedUi({ confirm: [false] });
		const outcome = await harness({ ui }).run();
		expect(outcome).toMatchObject({ status: "aborted", changed: [] });
		expect(renderInstallOutcome(outcome)).toContain("Nothing was changed");
	});

	it("returns the token path and still writes the workflow", async () => {
		const runner = fakeRunner();
		const writer = fakeBranchWriter();
		const ui = scriptedUi({
			confirm: [true],
			select: [TOKEN, "medium", "Read-only (read, grep, find, ls)", "Comment only (recommended)"],
		});
		const outcome = await harness({ runner, writeBranch: writer, ui }).run();
		expect(outcome).toMatchObject({ status: "token", repo, apiKeyPresent: true });
		expect(outcome.workflow?.branch).toBe("pi-review/setup");
		expect(writer.calls).toHaveLength(1);
		expect(parseSettings(JSON.parse(writer.calls[0]!.files[0]!.content)).identity).toBe("token");
		expect(writer.calls[0]!.files[1]!.content).not.toContain("create-github-app-token");
	});

	it("removes existing App identity when switching to GITHUB_TOKEN", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET] });
		const ui = scriptedUi({
			confirm: [true, true],
			select: [TOKEN, "medium", "Read-only", "Comment only"],
		});
		const outcome = await harness({ runner, ui }).run();
		expect(outcome).toMatchObject({
			status: "token",
			repo,
			changed: [APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE],
		});
	});

	it("warns about an incomplete identity pair", async () => {
		const ui = scriptedUi({ confirm: [false] });
		await harness({ runner: fakeRunner({ secrets: [APP_ID_SECRET] }), ui }).run();
		expect(ui.notifications.some((entry) => entry.message.includes("Only one of"))).toBe(true);
	});
});

describe("installPiReview create path", () => {
	it("creates the App, stores the key before the id, and writes the workflow", async () => {
		const writer = fakeBranchWriter();
		const { runner, server, opened, ui, run } = harness({ writeBranch: writer });
		const outcome = await run();

		expect(outcome).toMatchObject({
			status: "created",
			repo,
			app: { id: 1234, slug: "pi-review-x", name: "Pi Review" },
			installed: true,
			apiKeyPresent: true,
		});

		const sets = runner.calls.filter((call) => call.args[1] === "set");
		expect(sets[0]).toMatchObject({ args: ["secret", "set", APP_KEY_SECRET, "--repo", "owner/repo"], stdin: pem });
		expect(sets[1]).toMatchObject({ args: ["secret", "set", APP_ID_SECRET, "--repo", "owner/repo"], stdin: "1234" });
		expect(sets[2]).toMatchObject({
			args: ["variable", "set", APP_SLUG_VARIABLE, "--body", "pi-review-x", "--repo", "owner/repo"],
		});

		// Browser: the local submit page, the install page, then the PR compare page.
		expect(opened).toEqual([
			"http://127.0.0.1:9999/",
			"https://github.com/apps/pi-review-x/installations/new",
			"https://github.com/owner/repo/compare/main...pi-review/setup?expand=1",
		]);
		expect(server.closes.count).toBe(1);

		const settings = parseSettings(JSON.parse(writer.calls[0]!.files[0]!.content));
		expect(settings).toMatchObject({
			identity: "app",
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			thinking: "medium",
			tools: { bash: false },
			review: { event: "COMMENT" },
			pi: { version: "1.5.0", packageRef: "abc123" },
		});
		expect(writer.calls[0]!.files[1]!.content).toContain("actions/create-github-app-token@v1");
		expect(writer.calls[0]!.message).toBe("Add pi-review workflow and settings");
	});

	it("records bash, dependency install, and REQUEST_CHANGES from the settings prompts", async () => {
		const writer = fakeBranchWriter();
		const ui = scriptedUi({
			confirm: [true, true, true],
			select: [CREATE, "high", "Allow running tests (+ bash)", "Request changes on problems"],
		});
		const outcome = await harness({ ui, writeBranch: writer }).run();
		const settings = parseSettings(JSON.parse(writer.calls[0]!.files[0]!.content));
		expect(settings.tools.bash).toBe(true);
		expect(settings.verify.installDependencies).toBe(true);
		expect(settings.review.event).toBe("REQUEST_CHANGES");
		expect(settings.thinking).toBe("high");
		expect(writer.calls[0]!.files[1]!.content).toContain("--tools read,grep,find,ls,bash,submit_review");
		expect(writer.calls[0]!.files[1]!.content).toContain('PI_REVIEW_REQUEST_CHANGES: "1"');
		expect(outcome.workflow?.committed).toBe(true);
	});

	it("offers the organization when the owner is an org", async () => {
		const exec = fakeExec({ "gh api users/owner --jq .type": { stdout: "Organization" } });
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "owner (organization)", "medium", "Read-only", "Comment only"],
		});
		const server = fakeServerFactory();
		const outcome = await harness({ exec, ui, server }).run();
		expect(outcome.status).toBe("created");
		expect(server.started[0]!.submitUrl).toContain(
			"https://github.com/organizations/owner/settings/apps/new?state="
		);
	});

	it("finishes with an unconfirmed installation when the user does not confirm", async () => {
		const ui = scriptedUi({
			confirm: [true, false],
			select: [CREATE, "medium", "Read-only", "Comment only"],
		});
		const outcome = await harness({ ui }).run();
		expect(outcome).toMatchObject({ status: "created", installed: false });
	});

	it("reports an installation that does not appear yet", async () => {
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "medium", "Read-only", "Comment only"],
		});
		const outcome = await harness({ ui, waitForInstallation: async () => undefined }).run();
		expect(outcome).toMatchObject({ status: "created", installed: false });
		expect(ui.notifications.some((entry) => entry.message.includes("Could not confirm the installation"))).toBe(
			true
		);
	});

	it("accepts a pasted redirect URL when the browser timed out", async () => {
		const server = fakeServerFactory({ error: new ManifestTimeoutError() });
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "medium", "Read-only", "Comment only"],
			input: [() => `http://127.0.0.1:9999/callback?code=CODE-9&state=${server.started[0]?.state ?? ""}`],
		});
		// The state is generated inside the run, so build the answer lazily.
		const outcome = await harness({ ui, server }).run();
		expect(outcome.status).toBe("created");
	});

	it("aborts when the pasted URL does not belong to this run", async () => {
		const server = fakeServerFactory({ error: new ManifestTimeoutError() });
		const ui = scriptedUi({
			confirm: [true],
			select: [CREATE],
			input: ["http://127.0.0.1:9999/callback?code=CODE&state=wrong"],
		});
		const outcome = await harness({ ui, server }).run();
		expect(outcome).toMatchObject({
			status: "aborted",
			changed: [],
			reason: "that URL does not belong to this run",
		});
	});

	it("names the App when storing its secrets fails", async () => {
		const runner = fakeRunner({ failOn: APP_KEY_SECRET });
		await expect(harness({ runner }).run()).rejects.toThrow("The App was created (id 1234, slug pi-review-x)");
		const sets = runner.calls.filter((call) => call.args[1] === "set");
		expect(sets.map((call) => call.args[2])).toEqual([APP_KEY_SECRET]);
	});
});

describe("installPiReview reuse path", () => {
	it("reuses the stored App and writes the workflow", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET], slug: "pi-review-x" });
		const opened: string[] = [];
		const writer = fakeBranchWriter();
		const ui = scriptedUi({
			confirm: [true, true],
			select: [REUSE, "medium", "Read-only", "Comment only"],
		});
		const outcome = await harness({ runner, opened, ui, writeBranch: writer }).run();
		expect(outcome).toMatchObject({
			status: "existing",
			repo,
			appSlug: "pi-review-x",
			installed: true,
		});
		expect(opened[0]).toBe("https://github.com/apps/pi-review-x/installations/new");
		expect(runner.calls.filter((call) => call.args[1] === "set")).toEqual([]);
		expect(writer.calls).toHaveLength(1);
	});

	it("attaches an existing App from its ID and key file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-review-key-"));
		const keyPath = join(dir, "app.pem");
		await writeFile(keyPath, pem, "utf8");
		try {
			const runner = fakeRunner({ secrets: [] });
			const writer = fakeBranchWriter();
			const ui = scriptedUi({
				confirm: [true, true],
				select: [EXISTING, "medium", "Read-only", "Comment only"],
				input: ["1234", keyPath],
			});
			const outcome = await harness({ runner, ui, writeBranch: writer }).run();
			expect(outcome).toMatchObject({
				status: "existing",
				appSlug: "pi-review-x",
				installed: true,
				verified: true,
				changed: [APP_KEY_SECRET, APP_ID_SECRET, APP_SLUG_VARIABLE],
			});
			const key = runner.calls.find((call) => call.args[2] === APP_KEY_SECRET);
			expect(key?.stdin).toBe(pem);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an existing-App key file that does not exist", async () => {
		const ui = scriptedUi({
			confirm: [true],
			select: [EXISTING],
			input: ["1234", "/definitely/missing.pem"],
		});
		await expect(harness({ runner: fakeRunner({ secrets: [] }), ui }).run()).rejects.toThrow(
			"Could not read the private key"
		);
	});

	it("reports an unconfirmed installation when the user declines", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET], slug: "pi-review-x" });
		const ui = scriptedUi({
			confirm: [true, false],
			select: [REUSE, "medium", "Read-only", "Comment only"],
		});
		const outcome = await harness({ runner, ui }).run();
		expect(outcome).toMatchObject({ status: "existing", installed: false });
	});
});

describe("installPiReview cached App", () => {
	function routedFetch(): FetchLike & { calls: string[] } {
		const calls: string[] = [];
		const impl = async (url: string) => {
			calls.push(url);
			if (url.endsWith("/app")) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ id: 1234, slug: "pi-review-x", name: "Pi Review" }),
				};
			}
			if (url.includes("/installation")) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ id: 9 }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ id: 1234, slug: "pi-review-x", name: "Pi Review", pem }) };
		};
		return Object.assign(impl, { calls });
	}

	it("auto-attaches the cached App without asking for anything", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-review-cached-"));
		const keyPath = join(dir, "key.pem");
		const cachePath = join(dir, "pi-review.json");
		await writeFile(keyPath, pem, "utf8");
		await writeFile(
			cachePath,
			JSON.stringify({ owner: { appId: 1234, slug: "pi-review-x", keyPath } }),
			"utf8"
		);
		try {
			const runner = fakeRunner({ secrets: [] });
			const ui = scriptedUi({
				confirm: [true],
				select: ["medium", "Read-only", "Comment only"],
			});
			const outcome = await harness({
				runner,
				ui,
				cachePath,
				keyDir: dir,
				fetch: routedFetch(),
			}).run();
			expect(outcome).toMatchObject({
				status: "existing",
				appSlug: "pi-review-x",
				installed: true,
				verified: true,
			});
			expect(ui.prompts).not.toContain("Identity for reviews");
			expect(runner.calls.find((call) => call.args[2] === APP_KEY_SECRET)?.stdin).toBe(pem);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the App choices when the cached key file is gone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-review-cached-"));
		const cachePath = join(dir, "pi-review.json");
		await writeFile(
			cachePath,
			JSON.stringify({ owner: { appId: 1234, slug: "pi-review-x", keyPath: join(dir, "missing.pem") } }),
			"utf8"
		);
		try {
			const ui = scriptedUi({
				confirm: [true],
				select: [TOKEN, "medium", "Read-only", "Comment only"],
			});
			await harness({ runner: fakeRunner({ secrets: [] }), ui, cachePath, keyDir: dir }).run();
			expect(ui.prompts).toContain("Identity for reviews");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("saves a created App key for other repositories", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-review-save-"));
		const cachePath = join(dir, "pi-review.json");
		const keyDir = join(dir, "keys");
		try {
			const ui = scriptedUi({
				confirm: [true, true],
				select: [CREATE, "medium", "Read-only", "Comment only"],
			});
			const outcome = await harness({
				ui,
				cachePath,
				keyDir,
				saveAppKeyLocally: true,
			}).run();
			expect(outcome.status).toBe("created");
			const cache = JSON.parse(await readFile(cachePath, "utf8"));
			expect(cache.owner).toMatchObject({ appId: 1234, slug: "pi-review-x" });
			const savedKey = await readFile(cache.owner.keyPath, "utf8");
			expect(savedKey).toBe(pem);
			expect((await stat(cache.owner.keyPath)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("installPiReview settings and key", () => {
	it("skips the workflow when a settings prompt is cancelled", async () => {
		const writer = fakeBranchWriter();
		const ui = scriptedUi({ confirm: [true, true], select: [CREATE, undefined] });
		const outcome = await harness({ ui, writeBranch: writer }).run();
		expect(outcome.workflowSkipped).toBe(true);
		expect(outcome.workflow).toBeUndefined();
		expect(writer.calls).toHaveLength(0);
	});

	it("prompts for a model when the session has none", async () => {
		const writer = fakeBranchWriter();
		const safe = harnessDirsFor();
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "medium", "Read-only", "Comment only"],
			input: ["openrouter/anthropic/claude-sonnet-4.5"],
		});
		const outcome = await installPiReview({
			cwd,
			env,
			ui,
			deps: {
				exec: fakeExec(),
				run: fakeRunner({ secrets: [API_KEY_SECRET] }),
				startServer: fakeServerFactory().factory,
				openUrl: async () => true,
				fetch: fakeFetch(),
				waitForInstallation: async () => ({ id: 9 }),
				writeBranch: writer.writeBranch,
				cachePath: safe.cachePath,
				keyDir: safe.keyDir,
				saveAppKeyLocally: false,
			},
		});
		expect(outcome.status).toBe("created");
		const settings = parseSettings(JSON.parse(writer.calls[0]!.files[0]!.content));
		expect(settings.model).toBe("openrouter/anthropic/claude-sonnet-4.5");
	});

	it("stores a pasted provider key when the secret is missing", async () => {
		const writer = fakeBranchWriter();
		const runner = fakeRunner({ secrets: [] });
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "medium", "Read-only", "Comment only", "Paste an API key"],
			input: ["sk-test-secret"],
		});
		const outcome = await harness({ runner, ui, writeBranch: writer }).run();
		expect(outcome.apiKeySet).toBe(true);
		const key = runner.calls.find((call) => call.args[2] === API_KEY_SECRET);
		expect(key?.stdin).toBe("sk-test-secret");
		expect(renderInstallOutcome(outcome)).toContain(`\`${API_KEY_SECRET}\`: set`);
	});

	it("signs in to OpenCode Go and stores the minted key", async () => {
		const runner = fakeRunner({ secrets: [] });
		const ui = scriptedUi({
			confirm: [true, true],
			select: [
				CREATE,
				"medium",
				"Read-only",
				"Comment only",
				"Sign in to OpenCode Go (recommended)",
			],
		});
		const outcome = await harness({
			runner,
			ui,
			authorizeOpenCode: async () => "oc_sk_minted",
		}).run();
		expect(outcome.apiKeySet).toBe(true);
		const keyCall = runner.calls.find((call) => call.args[2] === API_KEY_SECRET);
		expect(keyCall?.stdin).toBe("oc_sk_minted");
	});

	it("authorizes OpenRouter with a repository-scoped key label", async () => {
		const runner = fakeRunner({ secrets: [] });
		let label: string | undefined;
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "medium", "Read-only", "Comment only", "Authorize OpenRouter (recommended)"],
		});
		const outcome = await harness({
			runner,
			ui,
			defaults: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
			authorizeOpenRouter: async (options) => {
				label = options.keyLabel;
				return "sk-or-v1-minted";
			},
		}).run();
		expect(outcome.apiKeySet).toBe(true);
		expect(label).toBe("pi-review-owner-repo");
		const keyCall = runner.calls.find((call) => call.args[2] === API_KEY_SECRET);
		expect(keyCall?.stdin).toBe("sk-or-v1-minted");
	});

	it("warns instead of prompting when the provider has no known env var", async () => {
		const runner = fakeRunner({ secrets: [] });
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE, "medium", "Read-only", "Comment only"],
		});
		await harness({
			runner,
			ui,
			defaults: { provider: "custom-thing", model: "m" },
		}).run();
		expect(ui.selects.some((entry) => entry.title.startsWith("Review API key"))).toBe(false);
		expect(ui.notifications.some((entry) => entry.message.includes("No env var is known"))).toBe(true);
	});

	it("leaves the key unset when the user declines", async () => {
		const runner = fakeRunner({ secrets: [] });
		const ui = scriptedUi({
			confirm: [true, true, false],
			select: [CREATE, "medium", "Read-only", "Comment only"],
		});
		const outcome = await harness({ runner, ui }).run();
		expect(outcome.apiKeySet).toBe(false);
		expect(outcome.apiKeyPresent).toBe(false);
		const summary = renderInstallOutcome(outcome);
		expect(summary).toContain("**not set**");
		expect(summary).toContain(`gh secret set ${API_KEY_SECRET}`);
	});

	it("keeps the identity result when the workflow cannot be written", async () => {
		const writeBranch = async () => {
			throw new Error("remote rejected: protected branch");
		};
		const outcome = await harness({ writeBranch: { writeBranch, calls: [] } }).run();
		expect(outcome.status).toBe("created");
		expect(outcome.workflowError).toContain("protected branch");
		expect(renderInstallOutcome(outcome)).toContain("Could not write it");
	});
});

describe("renderInstallOutcome", () => {
	const base = defaultSettings({ provider: "opencode-go", model: "m" });

	it("lists the workflow branch and revocation steps", () => {
		const text = renderInstallOutcome({
			status: "created",
			repo,
			app: { id: 1234, slug: "pi-review-x", name: "Pi Review" },
			installed: true,
			changed: [APP_KEY_SECRET, APP_ID_SECRET, APP_SLUG_VARIABLE],
			apiKeyPresent: true,
			workflow: {
				branch: "pi-review/setup",
				compareUrl: "https://github.com/owner/repo/compare/main...pi-review/setup?expand=1",
				committed: true,
				pushed: true,
				files: [".github/pi-review.json", ".github/workflows/pi-review.yml"],
				settingsPath: ".github/pi-review.json",
				workflowPath: ".github/workflows/pi-review.yml",
			},
		});
		expect(text).toContain("Pi GitHub App ready");
		expect(text).toContain("`pi-review/setup`");
		expect(text).toContain("https://github.com/owner/repo/compare/main...pi-review/setup?expand=1");
		expect(text).toContain(`gh secret delete ${APP_ID_SECRET} --repo owner/repo`);
		expect(text).toContain("https://github.com/settings/apps/pi-review-x/advanced");
		expect(text).toContain(`\`${API_KEY_SECRET}\`: set`);
		expect(base.model).toBe("m");
	});

	it("points at the install page when it was not confirmed", () => {
		const text = renderInstallOutcome({
			status: "created",
			repo,
			app: { id: 1234, slug: "pi-review-x", name: "Pi Review" },
			installed: false,
			changed: [],
		});
		expect(text).toContain("not confirmed yet");
		expect(text).toContain("https://github.com/apps/pi-review-x/installations/new");
	});

	it("describes a cancelled workflow", () => {
		const text = renderInstallOutcome({
			status: "existing",
			repo,
			appSlug: "pi-review-x",
			installed: true,
			verified: false,
			changed: [],
			workflowSkipped: true,
		});
		expect(text).toContain("Not written");
	});

	it("describes the token fallback", () => {
		const text = renderInstallOutcome({ status: "token", repo, changed: [], apiKeyPresent: false });
		expect(text).toContain("github-actions[bot]");
		expect(text).toContain(API_KEY_SECRET);
		expect(text).toContain(`gh secret set ${API_KEY_SECRET} --repo owner/repo`);
	});
});
