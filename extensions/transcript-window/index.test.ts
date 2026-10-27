import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import transcriptWindow from "./index.ts";
import { configPath, readConfig, writeConfig } from "./config.ts";

const STATE_KEY = "__pi_transcript_window_state__";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeChat extends Component {
	children: Component[];
	addChild(component: Component): void;
}

function lineComponent(line: string): Component {
	return {
		render: () => [line],
		invalidate: () => {},
	};
}

function makeChat(count: number): FakeChat {
	const chat: FakeChat = {
		children: Array.from({ length: count }, (_, index) =>
			lineComponent(`line-${index + 1}`)
		),
		addChild(component) {
			this.children.push(component);
		},
		render(width) {
			return this.children.flatMap((child) => child.render(width));
		},
		invalidate() {},
	};
	return chat;
}

function makeHarness(chat: FakeChat) {
	const document = {
		children: [lineComponent("header"), lineComponent("resources"), chat],
		render: () => [],
		invalidate: () => {},
	};
	const tui = {
		children: [document],
		requestRender: vi.fn(),
	};
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: Handler }) => {
			commands.set(name, options);
		},
	};
	const theme = { fg: (_color: string, text: string) => text };
	const ui = {
		theme,
		setWidget: (
			_key: string,
			content: ((tuiArg: unknown, themeArg: unknown) => Component) | undefined
		) => {
			if (typeof content === "function") content(tui, theme);
		},
		notify: vi.fn(),
		setStatus: vi.fn(),
	};
	const ctx = { mode: "tui", ui };

	return { pi, handlers, commands, tui, ctx };
}

let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "transcript-window-index-"));
	process.env.PI_CODING_AGENT_DIR = work;
	delete (globalThis as Record<string, unknown>)[STATE_KEY];
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete (globalThis as Record<string, unknown>)[STATE_KEY];
});

describe("transcript-window wiring", () => {
	it("installs a windowed render on session start", () => {
		const chat = makeChat(150);
		const { pi, handlers, ctx } = makeHarness(chat);
		transcriptWindow(pi as never);

		const start = handlers.get("session_start")?.[0];
		expect(start).toBeDefined();
		start?.({}, ctx);

		// The default keeps the last 100 items.
		let lines = chat.render(80);
		expect(lines[0]).toContain("50 earlier items hidden");
		expect(lines[1]).toBe("line-51");
		expect(lines.at(-1)).toBe("line-150");

		// Add enough components to push the window forward.
		for (let index = 151; index <= 200; index += 1) {
			chat.addChild(lineComponent(`line-${index}`));
		}
		lines = chat.render(80);
		expect(lines[0]).toContain("100 earlier items hidden");
		expect(lines[1]).toBe("line-101");
		expect(lines.at(-1)).toBe("line-200");
	});

	it("turns the window off and back on from the command", async () => {
		const chat = makeChat(60);
		const { pi, handlers, commands, ctx, tui } = makeHarness(chat);
		transcriptWindow(pi as never);
		handlers.get("session_start")?.[0]?.({}, ctx);

		const command = commands.get("window");
		expect(command).toBeDefined();

		await command?.handler("off", ctx);
		expect(readConfig().enabled).toBe(false);
		expect(chat.render(80)).toEqual(
			Array.from({ length: 60 }, (_, index) => `line-${index + 1}`)
		);
		expect(tui.requestRender).toHaveBeenCalledWith(true);

		await command?.handler("12", ctx);
		const config = readConfig();
		expect(config.enabled).toBe(true);
		expect(config.maxItems).toBe(12);
		const lines = chat.render(80);
		expect(lines[0]).toContain("48 earlier items hidden");
		expect(lines[1]).toBe("line-49");
	});

	it("reads an existing config on session start", () => {
		writeConfig({ version: 1, enabled: false, maxItems: 8 }, configPath());
		const chat = makeChat(20);
		const { pi, handlers, ctx } = makeHarness(chat);
		transcriptWindow(pi as never);
		handlers.get("session_start")?.[0]?.({}, ctx);
		expect(chat.render(80)).toHaveLength(20);
	});
});
