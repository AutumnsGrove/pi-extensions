import { describe, expect, it } from "vitest";
import { buildOpenCodeGoProvider } from "./index.ts";

describe("buildOpenCodeGoProvider", () => {
	it("registers OpenCode Go with built-in models and a provisioning login", () => {
		const provider = buildOpenCodeGoProvider();
		expect(provider.id).toBe("opencode-go");
		expect(provider.name).toBe("OpenCode Go");
		expect(provider.auth.apiKey).toBeDefined();
		expect(typeof provider.auth.apiKey?.login).toBe("function");
		expect(provider.auth.oauth).toBeUndefined();
		expect(provider.getModels().length).toBeGreaterThan(0);
	});
});
