import { describe, expect, it } from "vitest";
import {
	APP_NAME_MAX_LENGTH,
	appAdvancedSettingsUrl,
	appInstallUrl,
	appNameFor,
	appSettingsUrl,
	buildManifest,
	manifestSubmitUrl,
	parseRedirectUrl,
} from "./manifest.ts";

const repo = { owner: "AutumnsGrove", repo: "pi-extensions" };

describe("appNameFor", () => {
	it("builds a lowercase, sanitized, length-capped name", () => {
		const name = appNameFor(repo);
		expect(name).toBe("pi-review-autumnsgrove-pi-extensio");
		expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
		expect(name).toMatch(/^[a-z0-9-]+$/);
	});

	it("does not leave a trailing dash after truncation", () => {
		const name = appNameFor({ owner: "abcdefghij-klm", repo: "nopqrstuv" });
		expect(name.endsWith("-")).toBe(false);
		expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
	});

	it("collapses repeated separators", () => {
		expect(appNameFor({ owner: "a  b", repo: "c__d" })).toBe("pi-review-a-b-c-d");
	});
});

describe("buildManifest", () => {
	it("requests only the review permissions", () => {
		const manifest = buildManifest({ repo, redirectUrl: "http://127.0.0.1:1234/callback" });
		expect(manifest.name).toBe(appNameFor(repo));
		expect(manifest.url).toBe("https://github.com/AutumnsGrove/pi-extensions");
		expect(manifest.redirect_url).toBe("http://127.0.0.1:1234/callback");
		expect(manifest.public).toBe(false);
		expect(manifest.request_oauth_on_install).toBe(false);
		expect(manifest.default_permissions).toEqual({
			contents: "read",
			pull_requests: "write",
			issues: "write",
		});
		expect(manifest.default_events).toEqual([]);
		expect("hook_attributes" in manifest).toBe(false);
	});

	it("accepts a name override", () => {
		expect(buildManifest({ repo, redirectUrl: "x", name: "custom" }).name).toBe("custom");
	});
});

describe("manifestSubmitUrl", () => {
	it("targets the personal or organization registration page", () => {
		expect(manifestSubmitUrl({ state: "abc" })).toBe(
			"https://github.com/settings/apps/new?state=abc"
		);
		expect(manifestSubmitUrl({ state: "a b", organization: "acme" })).toBe(
			"https://github.com/organizations/acme/settings/apps/new?state=a%20b"
		);
	});
});

describe("app URLs", () => {
	it("point at install, settings, and revocation pages", () => {
		expect(appInstallUrl("pi-review-x")).toBe("https://github.com/apps/pi-review-x/installations/new");
		expect(appSettingsUrl("pi-review-x")).toBe("https://github.com/settings/apps/pi-review-x");
		expect(appAdvancedSettingsUrl("pi-review-x")).toBe(
			"https://github.com/settings/apps/pi-review-x/advanced"
		);
	});
});

describe("parseRedirectUrl", () => {
	it("pulls the code and state out of the redirect", () => {
		expect(parseRedirectUrl("http://127.0.0.1:8080/callback?code=abc123&state=deadbeef")).toEqual({
			code: "abc123",
			state: "deadbeef",
		});
		expect(parseRedirectUrl("http://127.0.0.1:8080/callback?code=abc123")).toEqual({ code: "abc123" });
	});

	it("rejects input without a code or without a URL", () => {
		expect(parseRedirectUrl("")).toBeUndefined();
		expect(parseRedirectUrl("not a url")).toBeUndefined();
		expect(parseRedirectUrl("http://127.0.0.1:8080/callback?state=only")).toBeUndefined();
	});
});
