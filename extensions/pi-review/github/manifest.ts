/**
 * The GitHub App manifest pi-review asks GitHub to create.
 *
 * Permissions are deliberately minimal: read the repository, write reviews and
 * PR/issue comments. No webhooks, no OAuth, private to the owner. The plan is
 * one App per repository (`pi-review-<owner>-<repo>`), which keeps the identity
 * revocable per repo; a shared App can come later if the naming gets in the way.
 */

import type { RepoRef } from "../detect.ts";

/** GitHub rejects App names longer than 34 characters. */
export const APP_NAME_MAX_LENGTH = 34;

export interface AppManifest {
	name: string;
	url: string;
	description: string;
	redirect_url: string;
	public: boolean;
	request_oauth_on_install: boolean;
	default_permissions: Record<string, "read" | "write">;
	default_events: string[];
}

/** A stable, readable App name; GitHub lets the user edit it before creating. */
export function appNameFor(repo: RepoRef): string {
	const raw = `pi-review-${repo.owner}-${repo.repo}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const trimmed = raw.slice(0, APP_NAME_MAX_LENGTH).replace(/-+$/, "");
	return trimmed || "pi-review";
}

export interface ManifestOptions {
	repo: RepoRef;
	redirectUrl: string;
	name?: string;
}

export function buildManifest(options: ManifestOptions): AppManifest {
	return {
		name: options.name ?? appNameFor(options.repo),
		url: `https://github.com/${options.repo.owner}/${options.repo.repo}`,
		description: "Agentic pull-request review with pi",
		redirect_url: options.redirectUrl,
		public: false,
		request_oauth_on_install: false,
		default_permissions: {
			contents: "read",
			pull_requests: "write",
			issues: "write",
		},
		default_events: [],
	};
}

/**
 * Where the browser POSTs the manifest. GitHub exposes the same flow under
 * `/organizations/<org>/settings/apps/new` for organization-owned Apps.
 */
export function manifestSubmitUrl(options: { organization?: string; state: string }): string {
	const base = options.organization
		? `https://github.com/organizations/${encodeURIComponent(options.organization)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	return `${base}?state=${encodeURIComponent(options.state)}`;
}

export function appInstallUrl(slugOrId: string): string {
	return `https://github.com/apps/${encodeURIComponent(slugOrId)}/installations/new`;
}

export function appSettingsUrl(slug: string): string {
	return `https://github.com/settings/apps/${encodeURIComponent(slug)}`;
}

export function appAdvancedSettingsUrl(slug: string): string {
	return `https://github.com/settings/apps/${encodeURIComponent(slug)}/advanced`;
}

export function installationsSettingsUrl(): string {
	return "https://github.com/settings/installations";
}

/** Pull the code and state out of the URL GitHub sent the browser to. */
export function parseRedirectUrl(input: string): { code: string; state?: string } | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	const code = url.searchParams.get("code");
	if (!code) return undefined;
	const state = url.searchParams.get("state") ?? undefined;
	return { code, ...(state ? { state } : {}) };
}
