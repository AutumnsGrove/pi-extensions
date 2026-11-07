import { describe, expect, it } from "vitest";
import {
	ManifestCancelledError,
	ManifestTimeoutError,
	startManifestServer,
} from "./server.ts";

const state = "state-123";

function start(overrides: { timeoutMs?: number } = {}) {
	return startManifestServer({
		state,
		submitUrl: `https://github.com/settings/apps/new?state=${state}`,
		buildManifest: (redirectUrl) => ({
			name: "pi-review-test",
			redirect_url: redirectUrl,
			default_permissions: { contents: "read" },
		}),
		timeoutMs: overrides.timeoutMs ?? 5_000,
	});
}

describe("startManifestServer", () => {
	it("serves a form that posts the manifest to GitHub", async () => {
		const server = await start();
		try {
			expect(server.startUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
			expect(server.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
			const html = await (await fetch(server.startUrl)).text();
			expect(html).toContain('method="post"');
			expect(html).toContain(`action="https://github.com/settings/apps/new?state=${state}"`);
			expect(html).toContain('name="manifest"');
			// The manifest is embedded as an escaped attribute, not raw JSON.
			expect(html).toContain("redirect_url&quot;:&quot;");
			expect(html).toContain("pi-review-test");
			expect(html).toContain("requestSubmit()");
		} finally {
			await server.close();
		}
	});

	it("resolves with the code once GitHub redirects with the right state", async () => {
		const server = await start();
		await fetch(server.startUrl);
		const response = await fetch(`${server.redirectUrl}?code=CODE-1&state=${state}`);
		expect(response.status).toBe(200);
		expect(await server.waitForCode).toBe("CODE-1");
		await server.close();
	});

	it("rejects a redirect with the wrong state and keeps waiting", async () => {
		const server = await start();
		const bad = await fetch(`${server.redirectUrl}?code=CODE-2&state=wrong`);
		expect(bad.status).toBe(400);
		expect((await bad.text()).toLowerCase()).toContain("state mismatch");

		const good = await fetch(`${server.redirectUrl}?code=CODE-3&state=${state}`);
		expect(good.status).toBe(200);
		expect(await server.waitForCode).toBe("CODE-3");
		await server.close();
	});

	it("rejects a redirect without a code", async () => {
		const server = await start();
		const response = await fetch(`${server.redirectUrl}?state=${state}`);
		expect(response.status).toBe(400);
		await server.close();
	});

	it("times out when the browser never comes back", async () => {
		const server = await start({ timeoutMs: 30 });
		await expect(server.waitForCode).rejects.toBeInstanceOf(ManifestTimeoutError);
		await server.close();
	});

	it("rejects a pending wait when the caller closes the server", async () => {
		const server = await start();
		const pending = server.waitForCode;
		await server.close();
		await expect(pending).rejects.toBeInstanceOf(ManifestCancelledError);
	});
});
