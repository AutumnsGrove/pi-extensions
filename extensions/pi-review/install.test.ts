import { describe, expect, it } from "vitest";
import type { Exec } from "./detect.ts";
import type { CommandRunner } from "./github/exec.ts";
import { APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE } from "./github/secrets.ts";
import type { ManifestServer, ManifestServerOptions } from "./github/server.ts";
import { ManifestTimeoutError } from "./github/server.ts";
import { installPiReview, renderInstallOutcome, type WizardUI } from "./install.ts";

const CREATE = "Create a Pi GitHub App (recommended)";
const REUSE = "Reuse the existing Pi GitHub App";
const TOKEN = "Use GITHUB_TOKEN instead (no App)";
const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
const repo = { owner: "owner", repo: "repo" };
const cwd = "/repo";

type Answer<T> = T | (() => T);

function scriptedUi(script: {
	confirm?: Answer<boolean>[];
	select?: Answer<string | undefined>[];
	input?: Answer<string | undefined>[];
}): WizardUI & { notifications: { message: string; type?: string }[]; prompts: string[] } {
	const confirms = [...(script.confirm ?? [])];
	const selects = [...(script.select ?? [])];
	const inputs = [...(script.input ?? [])];
	const notifications: { message: string; type?: string }[] = [];
	const prompts: string[] = [];
	const take = <T>(queue: Answer<T>[], kind: string): T => {
		const next = queue.shift();
		if (next === undefined) throw new Error(`no scripted ${kind} answer left`);
		return typeof next === "function" ? (next as () => T)() : next;
	};
	return {
		notifications,
		prompts,
		async confirm(title) {
			prompts.push(title);
			return take(confirms, "confirm");
		},
		async select(title) {
			prompts.push(title);
			return take(selects, "select");
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
		"gh api user --jq .login": { stdout: "me" },
		"gh api users/owner --jq .type": { stdout: "User" },
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
		if (args[0] === "variable" && args[1] === "set") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "variable" && args[1] === "delete") return { stdout: "", stderr: "", code: 0 };
		if (args[0] === "api" && args[1]?.includes("/actions/secrets")) {
			const secrets = options.secrets ?? [];
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

function installationExec(installed = true): Record<string, { stdout?: string; code?: number }> {
	return {
		"gh api /user/installations?per_page=100": {
			stdout: JSON.stringify({
				installations: [{ id: 9, app_id: 1234, app_slug: "pi-review-x" }],
			}),
		},
		"gh api /user/installations/9/repositories?per_page=100": {
			stdout: JSON.stringify({
				repositories: installed ? [{ full_name: "owner/repo" }] : [],
			}),
		},
	};
}

describe("installPiReview preflight", () => {
	const base = {
		cwd,
		deps: { exec: fakeExec(), run: fakeRunner() },
	};

	it("refuses a checkout without a github.com remote", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "", code: 1 });
		await expect(
			installPiReview({ ...base, deps: { ...base.deps, exec }, ui: scriptedUi({}) })
		).rejects.toThrow("Not a github.com checkout");
	});

	it("refuses when gh is not authenticated", async () => {
		const exec = fakeExec({ "gh auth status": { code: 1 } });
		await expect(
			installPiReview({ ...base, deps: { ...base.deps, exec }, ui: scriptedUi({}) })
		).rejects.toThrow("gh auth login");
	});

	it("refuses without repository admin", async () => {
		const exec = fakeExec({ "gh api repos/owner/repo --jq .permissions.admin": { stdout: "false" } });
		await expect(
			installPiReview({ ...base, deps: { ...base.deps, exec }, ui: scriptedUi({}) })
		).rejects.toThrow("Repository admin is required");
	});
});

describe("installPiReview choice handling", () => {
	it("aborts cleanly when the plan is declined", async () => {
		const ui = scriptedUi({ confirm: [false] });
		const outcome = await installPiReview({
			cwd,
			ui,
			deps: { exec: fakeExec(installationExec()), run: fakeRunner() },
		});
		expect(outcome).toEqual({ status: "aborted", changed: [] });
		expect(renderInstallOutcome(outcome)).toContain("Nothing was changed");
	});

	it("returns the token path without touching secrets when there are none", async () => {
		const runner = fakeRunner();
		const outcome = await installPiReview({
			cwd,
			ui: scriptedUi({ confirm: [true], select: [TOKEN] }),
			deps: { exec: fakeExec(installationExec()), run: runner },
		});
		expect(outcome).toEqual({ status: "token", changed: [] });
		expect(runner.calls.filter((call) => call.args[1] === "delete")).toEqual([]);
	});

	it("removes existing App identity when switching to GITHUB_TOKEN", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET] });
		const outcome = await installPiReview({
			cwd,
			ui: scriptedUi({ confirm: [true, true], select: [TOKEN] }),
			deps: { exec: fakeExec(installationExec()), run: runner },
		});
		expect(outcome).toEqual({
			status: "token",
			changed: [APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE],
		});
		const deleted = runner.calls.filter((call) => call.args[1] === "delete").map((call) => call.args[2]);
		expect(deleted).toEqual([APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE]);
	});

	it("warns about an incomplete identity pair", async () => {
		const ui = scriptedUi({ confirm: [false] });
		await installPiReview({
			cwd,
			ui,
			deps: { exec: fakeExec(installationExec()), run: fakeRunner({ secrets: [APP_ID_SECRET] }) },
		});
		expect(ui.notifications.some((entry) => entry.message.includes("Only one of"))).toBe(true);
	});
});

describe("installPiReview create path", () => {
	function createOptions(overrides: {
		exec?: Exec;
		runner?: ReturnType<typeof fakeRunner>;
		ui?: WizardUI;
		server?: ReturnType<typeof fakeServerFactory>;
		opened?: string[];
	} = {}) {
		const server = overrides.server ?? fakeServerFactory();
		const opened = overrides.opened ?? [];
		const runner = overrides.runner ?? fakeRunner();
		return {
			cwd,
			ui:
				overrides.ui ??
				scriptedUi({ confirm: [true, true], select: [CREATE] }),
			deps: {
				exec: overrides.exec ?? fakeExec(installationExec()),
				run: runner,
				startServer: server.factory,
				openUrl: async (url: string) => {
					opened.push(url);
					return true;
				},
				fetch: fakeFetch(),
			},
			runner,
			server,
			opened,
		};
	}

	it("creates the App, stores the key before the id, and confirms the installation", async () => {
		const options = createOptions();
		const outcome = await installPiReview({ cwd, ui: options.ui, deps: options.deps });

		expect(outcome).toEqual({
			status: "created",
			repo,
			app: { id: 1234, slug: "pi-review-x", name: "Pi Review" },
			installed: true,
			changed: [APP_KEY_SECRET, APP_ID_SECRET, APP_SLUG_VARIABLE],
		});

		const sets = options.runner.calls.filter((call) => call.args[1] === "set");
		expect(sets[0]).toMatchObject({ args: ["secret", "set", APP_KEY_SECRET, "--repo", "owner/repo"], stdin: pem });
		expect(sets[1]).toMatchObject({ args: ["secret", "set", APP_ID_SECRET, "--repo", "owner/repo"], stdin: "1234" });
		expect(sets[2]).toMatchObject({ args: ["variable", "set", APP_SLUG_VARIABLE, "--body", "pi-review-x", "--repo", "owner/repo"] });
		expect(sets[0]!.stdin).not.toBe(sets[1]!.stdin);

		// Browser: the local submit page first, then the installation page.
		expect(options.opened).toEqual([
			"http://127.0.0.1:9999/",
			"https://github.com/apps/pi-review-x/installations/new",
		]);
		expect(options.server.closes.count).toBe(1);
		// Personal account: no organization in the registration URL.
		expect(options.server.started[0]!.submitUrl).toBe("https://github.com/settings/apps/new?state=" + options.server.started[0]!.state);
		// The manifest carries the server's own redirect URL.
		const manifest = options.server.started[0]!.buildManifest("http://127.0.0.1:9999/callback") as {
			redirect_url: string;
			default_permissions: Record<string, string>;
		};
		expect(manifest.redirect_url).toBe("http://127.0.0.1:9999/callback");
		expect(manifest.default_permissions).toEqual({ contents: "read", pull_requests: "write", issues: "write" });
	});

	it("offers the organization when the owner is an org", async () => {
		const exec = fakeExec({
			"gh api users/owner --jq .type": { stdout: "Organization" },
			...installationExec(),
		});
		const ui = scriptedUi({ confirm: [true, true], select: [CREATE, "owner (organization)"] });
		const server = fakeServerFactory();
		const outcome = await installPiReview({
			cwd,
			ui,
			deps: {
				exec,
				run: fakeRunner(),
				startServer: server.factory,
				openUrl: async () => true,
				fetch: fakeFetch(),
			},
		});
		expect(outcome.status).toBe("created");
		expect(server.started[0]!.submitUrl).toContain("https://github.com/organizations/owner/settings/apps/new?state=");
	});

	it("finishes with an unconfirmed installation when the user does not confirm", async () => {
		const options = createOptions({
			exec: fakeExec(installationExec(false)),
			ui: scriptedUi({ confirm: [true, false], select: [CREATE] }),
		});
		const outcome = await installPiReview({ cwd, ui: options.ui, deps: options.deps });
		expect(outcome).toMatchObject({ status: "created", installed: false });
	});

	it("accepts a pasted redirect URL when the browser timed out", async () => {
		const server = fakeServerFactory({ error: new ManifestTimeoutError() });
		const stateOf = (): string => server.started[0]!.state;
		const ui = scriptedUi({
			confirm: [true, true],
			select: [CREATE],
			input: [() => `http://127.0.0.1:9999/callback?code=CODE-9&state=${stateOf()}`],
		});
		const outcome = await installPiReview({
			cwd,
			ui,
			deps: {
				exec: fakeExec(installationExec()),
				run: fakeRunner(),
				startServer: server.factory,
				openUrl: async () => true,
				fetch: fakeFetch(),
			},
		});
		expect(outcome.status).toBe("created");
	});

	it("aborts when the pasted URL does not belong to this run", async () => {
		const server = fakeServerFactory({ error: new ManifestTimeoutError() });
		const ui = scriptedUi({
			confirm: [true],
			select: [CREATE],
			input: ["http://127.0.0.1:9999/callback?code=CODE&state=wrong"],
		});
		const outcome = await installPiReview({
			cwd,
			ui,
			deps: {
				exec: fakeExec(installationExec()),
				run: fakeRunner(),
				startServer: server.factory,
				openUrl: async () => true,
				fetch: fakeFetch(),
			},
		});
		expect(outcome).toMatchObject({ status: "aborted", changed: [], reason: "that URL does not belong to this run" });
	});

	it("names the App when storing its secrets fails", async () => {
		const runner = fakeRunner({ failOn: APP_KEY_SECRET });
		const options = createOptions({ runner });
		await expect(installPiReview({ cwd, ui: options.ui, deps: options.deps })).rejects.toThrow(
			"The App was created (id 1234, slug pi-review-x)"
		);
		const sets = runner.calls.filter((call) => call.args[1] === "set");
		expect(sets.map((call) => call.args[2])).toEqual([APP_KEY_SECRET]);
	});
});

describe("installPiReview reuse path", () => {
	it("reuses the stored App and verifies the installation", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET], slug: "pi-review-x" });
		const outcome = await installPiReview({
			cwd,
			ui: scriptedUi({ confirm: [true], select: [REUSE] }),
			deps: { exec: fakeExec(installationExec()), run: runner },
		});
		expect(outcome).toEqual({
			status: "existing",
			repo,
			appSlug: "pi-review-x",
			installed: true,
			changed: [],
		});
		// Nothing is rewritten on a reuse.
		expect(runner.calls.filter((call) => call.args[1] === "set")).toEqual([]);
	});

	it("opens the install page when the App is not installed on the repo", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET], slug: "pi-review-x" });
		const opened: string[] = [];
		const ui = scriptedUi({ confirm: [true, true], select: [REUSE] });
		const outcome = await installPiReview({
			cwd,
			ui,
			deps: {
				exec: fakeExec(installationExec(false)),
				run: runner,
				openUrl: async (url) => {
					opened.push(url);
					return true;
				},
			},
		});
		expect(outcome).toMatchObject({ status: "existing", installed: false });
		expect(opened).toEqual(["https://github.com/apps/pi-review-x/installations/new"]);
		expect(ui.notifications.some((entry) => entry.message.includes("Could not confirm"))).toBe(true);
	});

	it("warns when no installation is visible", async () => {
		const runner = fakeRunner({ secrets: [APP_ID_SECRET, APP_KEY_SECRET], slug: "pi-review-x" });
		const ui = scriptedUi({ confirm: [true], select: [REUSE] });
		const outcome = await installPiReview({
			cwd,
			ui,
			deps: {
				exec: fakeExec({
					"gh api /user/installations?per_page=100": { stdout: JSON.stringify({ installations: [] }) },
				}),
				run: runner,
			},
		});
		expect(outcome).toMatchObject({ status: "existing", installed: false });
		expect(ui.notifications.some((entry) => entry.message.includes("No installation"))).toBe(true);
	});
});

describe("renderInstallOutcome", () => {
	it("lists revocation steps for a created App", () => {
		const text = renderInstallOutcome({
			status: "created",
			repo,
			app: { id: 1234, slug: "pi-review-x", name: "Pi Review" },
			installed: true,
			changed: [APP_KEY_SECRET, APP_ID_SECRET, APP_SLUG_VARIABLE],
		});
		expect(text).toContain("Pi GitHub App ready");
		expect(text).toContain("id 1234");
		expect(text).toContain(`gh secret delete ${APP_ID_SECRET} --repo owner/repo`);
		expect(text).toContain("https://github.com/settings/apps/pi-review-x/advanced");
		expect(text).toContain("installation: confirmed");
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

	it("describes the token fallback", () => {
		const text = renderInstallOutcome({ status: "token", changed: [APP_ID_SECRET] });
		expect(text).toContain("GITHUB_TOKEN");
		expect(text).toContain("github-actions[bot]");
		expect(text).toContain(`\`${APP_ID_SECRET}\``);
	});
});
