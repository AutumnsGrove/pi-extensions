import { describe, expect, it, vi } from "vitest";
import {
	completeDeviceSignIn,
	parseDeviceCode,
	parseTokens,
	provisionApiKey,
	resolveVerificationUrl,
} from "./oauth.ts";

const jsonResponse = (body: unknown, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
});

describe("resolveVerificationUrl", () => {
	it("resolves the origin-absolute path and canonicalizes the alias host", () => {
		expect(
			resolveVerificationUrl(
				"https://opencode.ai/console",
				"/console/device?user_code=ABCD-EFGH&client_id=opencode-cli"
			)
		).toBe("https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli");
		expect(resolveVerificationUrl("https://console.opencode.ai", "/console/device")).toBe(
			"https://opencode.ai/console/device"
		);
	});
});

describe("parseDeviceCode", () => {
	it("parses the device grant response", () => {
		const device = parseDeviceCode(
			{
				device_code: "dc",
				user_code: "ABCD-EFGH",
				verification_uri_complete: "/console/device?user_code=ABCD-EFGH",
				expires_in: 600,
				interval: 5,
			},
			"https://opencode.ai/console"
		);
		expect(device?.deviceCode).toBe("dc");
		expect(device?.intervalMs).toBe(5000);
		expect(device?.verificationUrl).toBe(
			"https://opencode.ai/console/device?user_code=ABCD-EFGH"
		);
	});

	it("requires a device code, user code, and verification URL", () => {
		expect(parseDeviceCode({ device_code: "dc" }, "https://opencode.ai/console")).toBeUndefined();
		expect(parseDeviceCode(null, "https://opencode.ai/console")).toBeUndefined();
	});
});

describe("parseTokens", () => {
	it("parses access/refresh/expiry and org id", () => {
		expect(
			parseTokens({ access_token: "a", refresh_token: "r", expires_in: 3600, org_id: "wrk_1" })
		).toEqual({ access: "a", refresh: "r", expiresIn: 3600, orgId: "wrk_1" });
	});

	it("requires an access token", () => {
		expect(parseTokens({ refresh_token: "r" })).toBeUndefined();
		expect(parseTokens(null)).toBeUndefined();
	});
});

describe("completeDeviceSignIn", () => {
	const device = {
		deviceCode: "dc",
		userCode: "ABCD-EFGH",
		verificationUrl: "https://opencode.ai/console/device",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: "https://opencode.ai/console",
	};

	it("keeps polling while authorization is pending, then returns tokens", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) return jsonResponse({ error: "authorization_pending" });
			return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
		}) as unknown as typeof fetch;

		const tokens = await completeDeviceSignIn(device, { fetcher: fetchMock, sleep: async () => {} });
		expect(tokens).toEqual({ access: "a", refresh: "r", expiresIn: 3600 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("surfaces access_denied", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "access_denied" })
		) as unknown as typeof fetch;
		await expect(
			completeDeviceSignIn(device, { fetcher: fetchMock, sleep: async () => {} })
		).rejects.toThrow(/denied/);
	});
});

describe("provisionApiKey", () => {
	const server = "https://opencode.ai/console";
	const keyName = "pi-test";

	const route = (url: string, method: string): unknown => {
		if (url.endsWith("/api/service-accounts") && method === "GET") {
			return { items: [{ account: { id: "svcacct_1", name: "pi" }, keys: [] }] };
		}
		if (url.endsWith("/api/service-accounts/svcacct_1") && method === "GET") {
			return {
				account: { id: "svcacct_1", name: "pi" },
				keys: [{ id: "old", name: keyName, status: "active" }],
			};
		}
		if (url.endsWith("/api/service-accounts/keys/old/revoke")) return {};
		if (url.endsWith("/api/service-accounts/svcacct_1/keys")) {
			return { key: { id: "new" }, token: "oc_sk_new" };
		}
		throw new Error(`unexpected ${method} ${url}`);
	};

	it("reuses the pi account, revokes the stale same-name key, and mints a new one", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${url}`);
			return jsonResponse(route(url, method));
		}) as unknown as typeof fetch;

		const key = await provisionApiKey(server, "session", { keyName, fetcher: fetchMock });
		expect(key).toBe("oc_sk_new");
		expect(calls.some((call) => call.endsWith("/keys/old/revoke"))).toBe(true);
		expect(calls.some((call) => call.endsWith("/api/service-accounts/svcacct_1/keys"))).toBe(true);
	});

	it("creates the pi service account when none exists", async () => {
		const created: string[] = [];
		const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/service-accounts") && method === "GET") return jsonResponse({ items: [] });
			if (url.endsWith("/api/service-accounts") && method === "POST") {
				created.push("create-account");
				return jsonResponse({ id: "svcacct_new", name: "pi" });
			}
			if (url.endsWith("/api/service-accounts/svcacct_new") && method === "GET") {
				return jsonResponse({ account: { id: "svcacct_new", name: "pi" }, keys: [] });
			}
			if (url.endsWith("/api/service-accounts/svcacct_new/keys") && method === "POST") {
				created.push("create-key");
				return jsonResponse({ key: { id: "k" }, token: "oc_sk_new" });
			}
			throw new Error(`unexpected ${method} ${url}`);
		}) as unknown as typeof fetch;

		const key = await provisionApiKey(server, "session", { keyName, fetcher: fetchMock });
		expect(key).toBe("oc_sk_new");
		expect(created).toEqual(["create-account", "create-key"]);
	});
});
