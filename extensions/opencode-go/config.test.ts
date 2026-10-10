import { describe, expect, it } from "vitest";
import { defaultKeyName, OPENCODE_CLIENT_ID, PROVIDER_ID, resolveServer } from "./config.ts";

describe("config", () => {
	it("uses stable provider and client ids", () => {
		expect(PROVIDER_ID).toBe("opencode-go");
		expect(OPENCODE_CLIENT_ID).toBe("opencode-cli");
	});

	it("prefers the explicit server override and strips trailing slashes", () => {
		expect(resolveServer("https://example.test/")).toBe("https://example.test");
		expect(resolveServer("https://example.test")).toBe("https://example.test");
	});

	it("derives a per-machine key name", () => {
		expect(defaultKeyName()).toMatch(/^pi-[A-Za-z0-9_-]+$/);
	});
});
