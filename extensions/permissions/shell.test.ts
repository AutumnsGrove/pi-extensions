import { describe, expect, it } from "vitest";
import {
	isOpaqueWrapper,
	normalizeSegment,
	segmentWrites,
	splitShell,
} from "./shell.ts";

describe("splitShell", () => {
	it("splits on &&, ||, ;, and pipes", () => {
		const result = splitShell("git status && npm test || echo failed; ls | head");
		expect(result.segments.map((segment) => segment.text)).toEqual([
			"git status",
			"npm test",
			"echo failed",
			"ls",
			"head",
		]);
		expect(result.opaque).toBe(false);
	});

	it("keeps quoted separators inside one segment", () => {
		const result = splitShell(`echo "a && b" && echo 'c; d'`);
		expect(result.segments.map((segment) => segment.text)).toEqual([
			`echo "a && b"`,
			`echo 'c; d'`,
		]);
	});

	it("strips comments without eating the rest of the line", () => {
		const result = splitShell("ls # show files\npwd");
		expect(result.segments.map((segment) => segment.text)).toEqual(["ls", "pwd"]);
	});

	it("flags command substitution, backticks, and heredocs", () => {
		expect(splitShell("echo $(cat x)").opaque).toBe(true);
		expect(splitShell("echo `cat x`").opaque).toBe(true);
		expect(splitShell("cat <<EOF").opaque).toBe(true);
		expect(splitShell("diff <(a) <(b)").opaque).toBe(true);
	});

	it("marks redirects as writes", () => {
		const result = splitShell("cat secrets > /tmp/out");
		expect(result.segments[0]?.writes).toBe(true);
		expect(result.writes).toBe(true);
	});

	it("does not mark a quoted > as a write", () => {
		const result = splitShell(`echo "a > b"`);
		expect(result.segments[0]?.writes).toBe(false);
	});

	it("drops env prefixes", () => {
		const result = splitShell("FOO=bar BAZ=qux git status");
		expect(result.segments[0]?.text).toBe("git status");
	});
});

describe("normalizeSegment", () => {
	it("collapses whitespace and strips assignments", () => {
		expect(normalizeSegment("  A=1   B='x y'   ls   -la ")).toBe("ls -la");
	});
});

describe("segmentWrites", () => {
	it("detects mutating commands and flags", () => {
		expect(segmentWrites("rm -rf x")).toBe(true);
		expect(segmentWrites("sed -i s/a/b/ f")).toBe(true);
		expect(segmentWrites("find . -delete")).toBe(true);
		expect(segmentWrites("git status")).toBe(false);
	});
});

describe("isOpaqueWrapper", () => {
	it("detects eval, shell -c, and source", () => {
		expect(isOpaqueWrapper("eval $X")).toBe(true);
		expect(isOpaqueWrapper("bash -c 'rm -rf /'")).toBe(true);
		expect(isOpaqueWrapper("source ./script.sh")).toBe(true);
		expect(isOpaqueWrapper("git status")).toBe(false);
	});
});
