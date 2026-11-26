import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.ts";
import { readInbox, waitOn } from "./store.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-board-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const exec = (...argv: string[]) => {
	const lines: string[] = [];
	const code = run(argv, { PI_BOARD_DIR: root }, (line) => lines.push(line));
	return { code, text: lines.join("\n") };
};

describe("board cli", () => {
	it("sends as human and shows it in the inbox", () => {
		expect(exec("send", "b", "task", "42", "is", "done")).toEqual({ code: 0, text: "sent to b (queued-unknown)" });
		expect(readInbox(root, "b")[0]).toMatchObject({ from: "human", body: "task 42 is done" });
		expect(exec("inbox", "b").text).toContain("from human");
	});

	it("posts a topic that a waiting lane receives", () => {
		waitOn(root, { lane: "b", topics: ["task:42-done"] });
		expect(exec("post", "task:42-done", "merged").text).toBe("posted task:42-done; notified b");
		expect(readInbox(root, "b")).toHaveLength(1);
	});

	it("says so when nobody is waiting yet", () => {
		expect(exec("post", "x").text).toContain("nobody yet");
	});

	it("reports an empty board and bad usage", () => {
		expect(exec("lanes").text).toBe("No lanes on this board yet.");
		expect(exec("send", "b").code).toBe(1);
		expect(exec("post").code).toBe(1);
		expect(exec("inbox").code).toBe(1);
		expect(exec("nope").code).toBe(1);
	});
});
