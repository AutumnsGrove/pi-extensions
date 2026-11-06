/**
 * GitHub App API calls the installer needs: exchange the manifest code, find
 * the authenticated account, and check whether the App is installed on the repo.
 *
 * The installation lookup uses the user's own `gh` token (`/user/installations`),
 * so no App JWT or key signing is needed before the App exists in CI. A secret's
 * value cannot be read back, so a re-run verifies the installation rather than
 * the stored key.
 */

import { type Exec, type RepoRef, run } from "../detect.ts";

export type FetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ManifestExchangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestExchangeError";
	}
}

export interface CreatedApp {
	id: number;
	slug: string;
	name: string;
	/** PEM private key. Never logged, printed, or written to disk. */
	pem: string;
}

/** Trade the manifest `code` for the App's id and private key. */
export async function exchangeManifestCode(
	code: string,
	deps: { fetch?: FetchLike } = {}
): Promise<CreatedApp> {
	const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const response = await doFetch(
		`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2026-03-10",
				"User-Agent": "pi-review",
			},
		}
	);
	const body = await response.text();
	if (!response.ok) {
		throw new ManifestExchangeError(
			`GitHub rejected the App registration code (${response.status}): ${body.slice(0, 300) || "no response body"}`
		);
	}
	let parsed: { id?: unknown; slug?: unknown; name?: unknown; pem?: unknown };
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new ManifestExchangeError("GitHub returned a registration response that was not JSON.");
	}
	const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
	if (!Number.isInteger(id) || typeof parsed.pem !== "string" || !parsed.pem.includes("PRIVATE KEY")) {
		throw new ManifestExchangeError("GitHub did not return a private key for the new App.");
	}
	return {
		id,
		slug: typeof parsed.slug === "string" ? parsed.slug : "",
		name: typeof parsed.name === "string" ? parsed.name : "",
		pem: parsed.pem,
	};
}

async function ghJson(exec: Exec, cwd: string, args: string[]): Promise<Record<string, unknown> | undefined> {
	const result = await run(exec, "gh", ["api", ...args], { cwd, timeout: 20_000 });
	if (result === undefined) return undefined;
	// `run` returns trimmed stdout; it is only undefined on a non-zero exit.
	try {
		const parsed = JSON.parse(result);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export async function authenticatedLogin(exec: Exec, cwd: string): Promise<string | undefined> {
	return run(exec, "gh", ["api", "user", "--jq", ".login"], { cwd, timeout: 15_000 }) || undefined;
}

export async function accountKind(
	exec: Exec,
	cwd: string,
	login: string
): Promise<"user" | "organization" | undefined> {
	const kind = await run(exec, "gh", ["api", `users/${encodeURIComponent(login)}`, "--jq", ".type"], {
		cwd,
		timeout: 15_000,
	});
	if (kind === "User") return "user";
	if (kind === "Organization") return "organization";
	return undefined;
}

export interface RepoInstallation {
	id: number;
}

async function installationResponse(
	fetchImpl: FetchLike,
	repo: RepoRef,
	jwt: string
): Promise<{ ok: boolean; status: number; body: string }> {
	const response = await fetchImpl(
		`https://api.github.com/repos/${repo.owner}/${repo.repo}/installation`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2026-03-10",
				"User-Agent": "pi-review",
				Authorization: `Bearer ${jwt}`,
			},
		}
	);
	return { ok: response.ok, status: response.status, body: await response.text() };
}

/**
 * Ask GitHub whether the App is installed on the repository. `undefined` means
 * "not installed" (404); anything else is an error worth surfacing.
 */
export async function getRepoInstallation(
	fetchImpl: FetchLike,
	repo: RepoRef,
	jwt: string
): Promise<RepoInstallation | undefined> {
	const response = await installationResponse(fetchImpl, repo, jwt);
	if (response.status === 404) return undefined;
	if (!response.ok) {
		throw new Error(
			`Could not check the App installation (${response.status}): ${response.body.slice(0, 200) || "no response body"}`
		);
	}
	let parsed: { id?: unknown };
	try {
		parsed = JSON.parse(response.body);
	} catch {
		throw new Error("GitHub returned an installation response that was not JSON.");
	}
	const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
	if (!Number.isInteger(id)) throw new Error("GitHub returned an installation without an id.");
	return { id };
}

export interface WaitOptions {
	attempts?: number;
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Installations can take a few seconds to appear after the user clicks
 * Install, so poll briefly before declaring failure.
 */
export async function waitForRepoInstallation(
	fetchImpl: FetchLike,
	repo: RepoRef,
	jwt: string,
	options: WaitOptions = {}
): Promise<RepoInstallation | undefined> {
	const attempts = options.attempts ?? 6;
	const delayMs = options.delayMs ?? 2_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const installation = await getRepoInstallation(fetchImpl, repo, jwt);
		if (installation) return installation;
		if (attempt < attempts - 1) await sleep(delayMs);
	}
	return undefined;
}
