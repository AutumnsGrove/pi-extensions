import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../detect.ts";
import {
	type FetchLike,
	ManifestExchangeError,
	accountKind,
	authenticatedLogin,
	exchangeManifestCode,
	findAppInstallation,
} from "./app.ts";

function fakeExec(responses: Record<string, { stdout?: string; code?: number }>): Exec {
	return async (command, args) => {
		const hit = responses[`${command} ${args.join(" ")}`];
		if (!hit) return { stdout: "", stderr: "not found", code: 1 };
		return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
	};
}

const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

function fakeFetch(response: { status?: number; body?: string }): FetchLike & { calls: { url: string; init?: unknown }[] } {
	const calls: { url: string; init?: unknown }[] = [];
	const fetchImpl = async (url: string, init?: unknown) => {
		calls.push({ url, init });
		const status = response.status ?? 201;
		return { ok: status >= 200 && status < 300, status, text: async () => response.body ?? "" };
	};
	return Object.assign(fetchImpl, { calls });
}

describe("exchangeManifestCode", () => {
	it("posts the code and returns the App identity and key", async () => {
		const fetchImpl = fakeFetch({
			body: JSON.stringify({ id: 1234, slug: "pi-review-x", name: "Pi Review", pem }),
		});
		const app = await exchangeManifestCode("CODE", { fetch: fetchImpl });
		expect(app).toEqual({ id: 1234, slug: "pi-review-x", name: "Pi Review", pem });
		expect(fetchImpl.calls[0]!.url).toBe("https://api.github.com/app-manifests/CODE/conversions");
		expect((fetchImpl.calls[0]!.init as { method?: string }).method).toBe("POST");
	});

	it("surfaces GitHub's rejection", async () => {
		const fetchImpl = fakeFetch({ status: 422, body: "code expired" });
		await expect(exchangeManifestCode("OLD", { fetch: fetchImpl })).rejects.toThrow(
			ManifestExchangeError
		);
		await expect(exchangeManifestCode("OLD", { fetch: fetchImpl })).rejects.toThrow("code expired");
	});

	it("rejects a response without a private key", async () => {
		const fetchImpl = fakeFetch({ body: JSON.stringify({ id: 1, slug: "x" }) });
		await expect(exchangeManifestCode("CODE", { fetch: fetchImpl })).rejects.toThrow(
			"did not return a private key"
		);
	});

	it("rejects a non-JSON body", async () => {
		const fetchImpl = fakeFetch({ body: "<html>oops" });
		await expect(exchangeManifestCode("CODE", { fetch: fetchImpl })).rejects.toThrow(
			"that was not JSON"
		);
	});
});

describe("account lookups", () => {
	it("reads the authenticated login", async () => {
		const exec = fakeExec({ "gh api user --jq .login": { stdout: "me" } });
		expect(await authenticatedLogin(exec, "/repo")).toBe("me");
	});

	it("classifies the owner as a user or organization", async () => {
		expect(
			await accountKind(fakeExec({ "gh api users/acme --jq .type": { stdout: "Organization" } }), "/repo", "acme")
		).toBe("organization");
		expect(
			await accountKind(fakeExec({ "gh api users/me --jq .type": { stdout: "User" } }), "/repo", "me")
		).toBe("user");
		expect(await accountKind(fakeExec({}), "/repo", "nobody")).toBeUndefined();
	});
});

describe("findAppInstallation", () => {
	const repo = { owner: "owner", repo: "repo" };
	const list = JSON.stringify({
		installations: [
			{ id: 9, app_id: 1234, app_slug: "pi-review-x" },
			{ id: 10, app_id: 9999, app_slug: "other-app" },
		],
	});
	const repos = JSON.stringify({ repositories: [{ full_name: "owner/repo" }, { full_name: "owner/other" }] });

	it("finds the installation by app id and checks the repository list", async () => {
		const exec = fakeExec({
			"gh api /user/installations?per_page=100": { stdout: list },
			"gh api /user/installations/9/repositories?per_page=100": { stdout: repos },
		});
		const lookup = await findAppInstallation(exec, "/repo", repo, { appId: 1234 });
		expect(lookup.repoInstalled).toBe(true);
		expect(lookup.installation).toMatchObject({ id: 9, appId: 1234, appSlug: "pi-review-x" });
		expect(lookup.installation?.repositories).toEqual(["owner/repo", "owner/other"]);
	});

	it("finds the installation by slug", async () => {
		const exec = fakeExec({
			"gh api /user/installations?per_page=100": { stdout: list },
			"gh api /user/installations/10/repositories?per_page=100": {
				stdout: JSON.stringify({ repositories: [] }),
			},
		});
		const lookup = await findAppInstallation(exec, "/repo", repo, { appSlug: "other-app" });
		expect(lookup.installation?.appSlug).toBe("other-app");
		expect(lookup.repoInstalled).toBe(false);
	});

	it("reports false when no installation matches", async () => {
		const exec = fakeExec({ "gh api /user/installations?per_page=100": { stdout: list } });
		expect(await findAppInstallation(exec, "/repo", repo, { appId: 5 })).toEqual({
			repoInstalled: false,
		});
	});

	it("reports false when the repository is not selected for the installation", async () => {
		const exec = fakeExec({
			"gh api /user/installations?per_page=100": { stdout: list },
			"gh api /user/installations/9/repositories?per_page=100": {
				stdout: JSON.stringify({ repositories: [{ full_name: "someone/else" }] }),
			},
		});
		const lookup = await findAppInstallation(exec, "/repo", repo, { appId: 1234 });
		expect(lookup.installation).toBeDefined();
		expect(lookup.repoInstalled).toBe(false);
	});

	it("tolerates a malformed list response", async () => {
		const exec = fakeExec({ "gh api /user/installations?per_page=100": { stdout: "{}" } });
		expect(await findAppInstallation(exec, "/repo", repo, { appId: 1 })).toEqual({
			repoInstalled: false,
		});
	});
});
