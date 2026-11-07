import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../detect.ts";
import {
	type FetchLike,
	ManifestExchangeError,
	accountKind,
	authenticatedLogin,
	exchangeManifestCode,
	getRepoInstallation,
	waitForRepoInstallation,
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

describe("getRepoInstallation", () => {
	const repo = { owner: "owner", repo: "repo" };

	function routedFetch(status: number, body = ""): FetchLike & { calls: { url: string; init?: { headers?: Record<string, string> } }[] } {
		const calls: { url: string; init?: { headers?: Record<string, string> } }[] = [];
		const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
			calls.push({ url, init });
			return { ok: status >= 200 && status < 300, status, text: async () => body };
		};
		return Object.assign(fetchImpl, { calls });
	}

	it("asks the repository installation endpoint with the App JWT", async () => {
		const fetchImpl = routedFetch(200, JSON.stringify({ id: 77 }));
		const installation = await getRepoInstallation(fetchImpl, repo, "JWT");
		expect(installation).toEqual({ id: 77 });
		expect(fetchImpl.calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/installation");
		expect(fetchImpl.calls[0]!.init?.headers?.Authorization).toBe("Bearer JWT");
	});

	it("returns undefined when the App is not installed", async () => {
		expect(await getRepoInstallation(routedFetch(404), repo, "JWT")).toBeUndefined();
	});

	it("throws on other failures", async () => {
		await expect(getRepoInstallation(routedFetch(401, "bad jwt"), repo, "JWT")).rejects.toThrow(
			"Could not check the App installation (401)"
		);
	});

	it("throws on a malformed response", async () => {
		await expect(getRepoInstallation(routedFetch(200, "not json"), repo, "JWT")).rejects.toThrow(
			"not JSON"
		);
	});
});

describe("waitForRepoInstallation", () => {
	const repo = { owner: "owner", repo: "repo" };

	it("retries until the installation appears", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return calls < 3
				? { ok: false, status: 404, text: async () => "" }
				: { ok: true, status: 200, text: async () => JSON.stringify({ id: 9 }) };
		};
		const sleeps: number[] = [];
		const installation = await waitForRepoInstallation(fetchImpl as FetchLike, repo, "JWT", {
			attempts: 5,
			delayMs: 10,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(installation).toEqual({ id: 9 });
		expect(calls).toBe(3);
		expect(sleeps).toEqual([10, 10]);
	});

	it("gives up after the last attempt", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return { ok: false, status: 404, text: async () => "" };
		};
		const installation = await waitForRepoInstallation(fetchImpl as FetchLike, repo, "JWT", {
			attempts: 3,
			sleep: async () => {},
		});
		expect(installation).toBeUndefined();
		expect(calls).toBe(3);
	});
});
