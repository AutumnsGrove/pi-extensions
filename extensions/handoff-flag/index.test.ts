import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import handoffFlag from "./index.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

interface WidgetCall {
	key: string;
	content: unknown;
	options: { placement?: string } | undefined;
}

interface WidgetComponent {
	render(width: number): string[];
}

type WidgetFactory = (tui: unknown, theme: Theme) => WidgetComponent;

interface Harness {
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	widgets: WidgetCall[];
	notifications: Array<{ message: string; level?: string }>;
	ctx: unknown;
	/** Fire a handler the way pi does, awaiting whatever it returns. */
	emit(event: string): Promise<unknown>;
	setCwd(cwd: string): void;
}

const harness = (cwd: string, mode = "tui"): Harness => {
	const handlers = new Map();
	const commands = new Map();
	const widgets: WidgetCall[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const state = { cwd };
	const ctx = {
		hasUI: true,
		mode,
		get cwd() {
			return state.cwd;
		},
		ui: {
			theme: plainTheme,
			setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
				widgets.push({ key, content, options }),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	handoffFlag(pi);
	return {
		handlers,
		commands,
		widgets,
		notifications,
		ctx,
		emit: async (event: string) => handlers.get(event)?.({}, ctx),
		setCwd: (next: string) => {
			state.cwd = next;
		},
	};
};

const repos: string[] = [];

const repo = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "handoff-flag-"));
	repos.push(dir);
	return dir;
};

const widgetLine = (h: Harness): string | null => {
	const content = h.widgets.at(-1)?.content;
	if (typeof content !== "function") return null;
	return (content as WidgetFactory)({}, plainTheme).render(80)[0] ?? "";
};

afterEach(async () => {
	while (repos.length > 0) {
		const dir = repos.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("handoff-flag extension", () => {
	it("shows a below-editor line while HANDOFF.md exists", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "HANDOFF.md"), "# HANDOFF\n");
		const h = harness(cwd);
		await h.emit("session_start");

		const call = h.widgets.at(-1);
		expect(call?.key).toBe("handoff-flag");
		expect(call?.options).toEqual({ placement: "belowEditor" });
		expect(widgetLine(h)).toBe("✓ HANDOFF.md · <1m");
		await h.emit("session_shutdown");
	});

	it("shows nothing when there is no handoff", async () => {
		const h = harness(await repo());
		await h.emit("session_start");
		expect(h.widgets.at(-1)?.content).toBeUndefined();
		await h.emit("session_shutdown");
	});

	it("removes the line once the file is deleted", async () => {
		const cwd = await repo();
		const path = join(cwd, "HANDOFF.md");
		await writeFile(path, "# HANDOFF\n");
		const h = harness(cwd);
		await h.emit("session_start");
		expect(typeof h.widgets.at(-1)?.content).toBe("function");

		await rm(path);
		await h.emit("turn_end");
		expect(h.widgets.at(-1)?.content).toBeUndefined();
		await h.emit("session_shutdown");
	});

	it("picks up a handoff written mid-session", async () => {
		const cwd = await repo();
		const h = harness(cwd);
		await h.emit("session_start");
		expect(h.widgets.at(-1)?.content).toBeUndefined();

		await writeFile(join(cwd, "HANDOFF.md"), "# HANDOFF\n");
		await h.emit("tool_execution_end");
		expect(widgetLine(h)).toBe("✓ HANDOFF.md · <1m");
		await h.emit("session_shutdown");
	});

	it("only looks at the repository root", async () => {
		const cwd = await repo();
		await mkdir(join(cwd, "docs"));
		await writeFile(join(cwd, "docs", "HANDOFF.md"), "# HANDOFF\n");
		const h = harness(cwd);
		await h.emit("session_start");
		expect(h.widgets.at(-1)?.content).toBeUndefined();
		await h.emit("session_shutdown");
	});

	it("does not repaint the widget when nothing changed", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "HANDOFF.md"), "# HANDOFF\n");
		const h = harness(cwd);
		await h.emit("session_start");
		const afterStart = h.widgets.length;

		await h.emit("turn_end");
		await h.emit("tool_execution_end");
		expect(h.widgets.length).toBe(afterStart);
		await h.emit("session_shutdown");
	});

	it("toggles the widget off and back on via the command", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "HANDOFF.md"), "# HANDOFF\n");
		const h = harness(cwd);
		await h.emit("session_start");

		const command = h.commands.get("handoff");
		expect(command).toBeDefined();

		await command?.handler("off", h.ctx);
		expect(h.widgets.at(-1)?.content).toBeUndefined();
		expect(h.notifications.at(-1)?.message).toBe("Handoff widget off");

		await command?.handler("on", h.ctx);
		expect(typeof h.widgets.at(-1)?.content).toBe("function");
		expect(h.notifications.at(-1)?.message).toBe("Handoff widget on");
		await h.emit("session_shutdown");
	});

	it("prints the handoff details for the command with no subcommand", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "HANDOFF.md"), "# HANDOFF\n");
		const h = harness(cwd);
		await h.emit("session_start");
		await h.commands.get("handoff")?.handler("", h.ctx);

		const message = h.notifications.at(-1)?.message ?? "";
		expect(message).toContain("HANDOFF.md — written");
		expect(message).toContain(cwd);
		expect(message).toContain("rm HANDOFF.md");
		await h.emit("session_shutdown");
	});

	it("tells you when there is no handoff", async () => {
		const h = harness(await repo());
		await h.emit("session_start");
		await h.commands.get("handoff")?.handler("", h.ctx);
		expect(h.notifications.at(-1)?.message).toContain("No HANDOFF.md in");
		await h.emit("session_shutdown");
	});

	it("reports the truth outside a TUI, where no widget is registered", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "HANDOFF.md"), "# HANDOFF\n");
		const h = harness(cwd, "rpc");
		await h.emit("session_start");
		expect(h.widgets).toHaveLength(0);

		await h.commands.get("handoff")?.handler("", h.ctx);
		const message = h.notifications.at(-1)?.message ?? "";
		expect(message).toContain("HANDOFF.md — written");
		expect(message).toContain(cwd);
		await h.emit("session_shutdown");
	});
});
