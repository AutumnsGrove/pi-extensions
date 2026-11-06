/** Which credential flow a provider gets in the installer. */

import type { RepoRef } from "../detect.ts";

export type ProviderFlow = "opencode-go" | "openrouter" | "manual";

export function providerFlow(provider: string): ProviderFlow {
	const normalized = provider.toLowerCase().replace(/_/g, "-");
	if (normalized === "opencode-go" || normalized === "opencode") return "opencode-go";
	if (normalized === "openrouter") return "openrouter";
	return "manual";
}

/**
 * Dedicated key name for a repository. Distinct from the interactive
 * `pi-<host>` key so provisioning can never revoke the developer's key.
 */
export function reviewKeyName(repo: RepoRef): string {
	const raw = `pi-review-${repo.owner}-${repo.repo}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	return raw.slice(0, 80);
}
