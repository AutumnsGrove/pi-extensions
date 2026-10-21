import { describe, expect, it } from "vitest";
import { VerdictCache } from "./cache.ts";
import { Grants } from "./grants.ts";
import type { Verdict } from "./types.ts";

const allow: Verdict = {
	decision: "allow",
	confidence: 0.95,
	reasons: ["ok"],
	provider: "jev",
	durationMs: 12,
};

describe("VerdictCache", () => {
	it("caches allow and deny, but not ask or errors", () => {
		const cache = new VerdictCache(true);
		const key = cache.key("bash", { command: "git status" }, "/repo");
		cache.set(key, allow);
		expect(cache.get(key)).toMatchObject({ decision: "allow", cached: true });

		cache.set(cache.key("bash", { command: "npm install" }, "/repo"), { ...allow, decision: "ask" });
		expect(cache.get(cache.key("bash", { command: "npm install" }, "/repo"))).toBeUndefined();

		cache.set(cache.key("bash", { command: "curl x" }, "/repo"), { ...allow, error: "boom" });
		expect(cache.get(cache.key("bash", { command: "curl x" }, "/repo"))).toBeUndefined();
	});

	it("keys on cwd", () => {
		const cache = new VerdictCache(true);
		const a = cache.key("bash", { command: "ls" }, "/a");
		const b = cache.key("bash", { command: "ls" }, "/b");
		expect(a).not.toBe(b);
	});

	it("can be disabled and cleared", () => {
		const disabled = new VerdictCache(false);
		const key = disabled.key("bash", { command: "ls" }, "/a");
		disabled.set(key, allow);
		expect(disabled.get(key)).toBeUndefined();

		const cache = new VerdictCache(true);
		cache.set(key, allow);
		cache.clear();
		expect(cache.get(key)).toBeUndefined();
		expect(cache.size).toBe(0);
	});
});

describe("Grants", () => {
	it("stores exact call grants", () => {
		const grants = new Grants();
		grants.add("k1", "Bash(git status)");
		expect(grants.get("k1")?.rule).toBe("Bash(git status)");
		expect(grants.get("k2")).toBeUndefined();
		expect(grants.size).toBe(1);
		grants.clear();
		expect(grants.list()).toEqual([]);
	});
});
