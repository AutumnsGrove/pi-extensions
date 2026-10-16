import { describe, expect, it } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import gitStatus from "./index.ts";

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
}

function harness(responses: Record<string, { stdout: string; code: number }>): Harness {
	const handlers = new Map();
	const commands = new Map();
	const widgets: WidgetCall[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/repo",
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
		exec: async (_command: string, args: string[]) => {
			const key = args.filter((arg) => arg !== "--no-optional-locks").join(" ");
			return responses[key] ?? { stdout: "", code: 128 };
		},
	} as unknown as ExtensionAPI;
	gitStatus(pi);
	return { handlers, commands, widgets, notifications, ctx };
}

const repoResponses = {
	"status --porcelain -z --branch -uall": {
		stdout: "## main...origin/main [ahead 1]\0 M a.txt\0?? b.txt\0",
		code: 0,
	},
	"diff --shortstat": { stdout: " 1 file changed, 2 insertions(+)", code: 0 },
	"diff --cached --shortstat": { stdout: " 1 file changed, 1 insertion(+)", code: 0 },
};

describe("git-status extension", () => {
	it("registers a below-editor widget on session start", async () => {
		const h = harness(repoResponses);
		await h.handlers.get("session_start")?.({}, h.ctx);

		const call = h.widgets.at(-1);
		expect(call?.key).toBe("git-status");
		expect(call?.options).toEqual({ placement: "belowEditor" });

		const component = (call?.content as WidgetFactory)({}, plainTheme);
		const line = component.render(200)[0];
		expect(line).toContain("⎇ main");
		expect(line).toContain("2 modified");
		expect(line).toContain("+3");
		expect(line).toContain("↑1");
	});

	it("clears the widget outside a git repository", async () => {
		const h = harness({});
		await h.handlers.get("session_start")?.({}, h.ctx);
		const call = h.widgets.at(-1);
		expect(call?.key).toBe("git-status");
		expect(call?.content).toBeUndefined();
	});

	it("toggles the widget off and back on via the command", async () => {
		const h = harness(repoResponses);
		await h.handlers.get("session_start")?.({}, h.ctx);

		const command = h.commands.get("git-status");
		expect(command).toBeDefined();

		await command?.handler("off", h.ctx);
		expect(h.widgets.at(-1)?.content).toBeUndefined();

		await command?.handler("on", h.ctx);
		expect(typeof h.widgets.at(-1)?.content).toBe("function");
	});

	it("prints details for the command with no subcommand", async () => {
		const h = harness(repoResponses);
		await h.handlers.get("session_start")?.({}, h.ctx);
		await h.commands.get("git-status")?.handler("", h.ctx);

		const message = h.notifications.at(-1)?.message ?? "";
		expect(message).toContain("Branch: main");
		expect(message).toContain("Changed files: 2");
	});
});
