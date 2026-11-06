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

export interface InstallationInfo {
	id: number;
	appId: number;
	appSlug: string;
	repositories: string[];
}

export interface InstallationLookup {
	installation?: InstallationInfo;
	/** True when the App installation covers this repository. */
	repoInstalled: boolean;
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Find an installation of the App (by id or slug) and check whether this repo
 * is in its selected repositories.
 */
export async function findAppInstallation(
	exec: Exec,
	cwd: string,
	repo: RepoRef,
	match: { appId?: number; appSlug?: string }
): Promise<InstallationLookup> {
	const list = await ghJson(exec, cwd, ["/user/installations?per_page=100"]);
	const raw = Array.isArray(list?.installations) ? (list.installations as unknown[]) : [];
	const installations = raw
		.map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined))
		.filter((entry): entry is Record<string, unknown> => entry !== undefined);

	const found = installations.find((entry) => {
		const appId = numberField(entry.app_id);
		if (match.appId !== undefined && appId === match.appId) return true;
		if (match.appSlug !== undefined && entry.app_slug === match.appSlug) return true;
		return false;
	});
	if (!found) return { repoInstalled: false };

	const id = numberField(found.id);
	if (id === undefined) return { repoInstalled: false };

	const repositories: string[] = [];
	const repos = await ghJson(exec, cwd, [`/user/installations/${id}/repositories?per_page=100`]);
	if (Array.isArray(repos?.repositories)) {
		for (const entry of repos.repositories as unknown[]) {
			if (typeof entry === "object" && entry !== null) {
				const fullName = (entry as Record<string, unknown>).full_name;
				if (typeof fullName === "string") repositories.push(fullName);
			}
		}
	}

	const installation: InstallationInfo = {
		id,
		appId: numberField(found.app_id) ?? 0,
		appSlug: typeof found.app_slug === "string" ? found.app_slug : "",
		repositories,
	};
	return {
		installation,
		repoInstalled: repositories.includes(`${repo.owner}/${repo.repo}`),
	};
}
