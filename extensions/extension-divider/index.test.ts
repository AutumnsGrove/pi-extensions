import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		// The real component needs a live AgentSession and an initialised theme.
		// The wiring under test only needs its rendered lines.
		FooterComponent: class {
			render(): string[] {
				return ["pwd line", "stats line", "pi status line"];
			}
		},
	};
});

import extensionDivider from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	commands: Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> }
	>;
}

const createMockPi = (): MockPi => {
	const handlers = new Map<string, Handler>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> }
	>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: unknown) => Promise<void> }
		) {
			commands.set(name, options);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands };
};

const createCtx = (overrides: Record<string, unknown> = {}) => {
	const setFooter = vi.fn();
	const notify = vi.fn();
	const statuses = new Map<string, string>();
	const footerData = {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const theme = { fg: (_color: string, text: string) => text };
	const tui = { requestRender: vi.fn() };
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: {},
		model: { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter" },
		getContextUsage: () => undefined,
		ui: { setFooter, notify },
		...overrides,
	};
	return { ctx, setFooter, notify, statuses, footerData, theme, tui };
};

describe("extensionDivider", () => {
	it("installs a footer on session start and replaces the status line", () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter, statuses, footerData, theme, tui } = createCtx();
		statuses.set("openrouter-pin", "pin: DeepSeek");
		statuses.set("parallel", "parallel 12/4000");

		mock.handlers.get("session_start")?.({}, ctx);
		expect(setFooter).toHaveBeenCalledTimes(1);

		const factory = setFooter.mock.calls[0]?.[0] as (
			tui: unknown,
			theme: unknown,
			footerData: unknown
		) => { render(width: number): string[] };
		const lines = factory(tui, theme, footerData).render(120);

		expect(lines).toEqual([
			"pwd line",
			"stats line",
			"pin: DeepSeek /// parallel 12/4000",
		]);
	});

	it("recolours the separator from the pride palette", () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter, statuses, footerData, tui } = createCtx();
		statuses.set("a", "alpha");
		statuses.set("b", "beta");

		mock.handlers.get("session_start")?.({}, ctx);
		const factory = setFooter.mock.calls[0]?.[0] as (
			tui: unknown,
			theme: unknown,
			footerData: unknown
		) => { render(width: number): string[] };

		// A pride theme exposes resolved colours per role; the separator samples
		// six of them, so three slashes draw the 0th, 3rd and 5th.
		const prideTheme = {
			name: "pride-dark",
			colors: {
				syntaxKeyword: "#red",
				syntaxFunction: "#orange",
				syntaxVariable: "#yellow",
				syntaxString: "#green",
				syntaxNumber: "#blue",
				syntaxType: "#violet",
			},
			style: (text: string, options: { fg?: string }) =>
				`<${options.fg}>${text}</>`,
			fg: (_color: string, text: string) => text,
		};

		const lines = factory(tui, prideTheme, footerData).render(120);
		expect(lines[2]).toBe("alpha <#red>/</><#green>/</><#violet>/</> beta");
	});

	it("does not divide a single status", () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter, statuses, footerData, theme, tui } = createCtx();
		statuses.set("parallel", "parallel 12/4000");

		mock.handlers.get("session_start")?.({}, ctx);
		const factory = setFooter.mock.calls[0]?.[0] as (
			tui: unknown,
			theme: unknown,
			footerData: unknown
		) => { render(width: number): string[] };

		expect(factory(tui, theme, footerData).render(120)[2]).toBe(
			"parallel 12/4000"
		);
	});

	it("does nothing when the UI is not a terminal", () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter } = createCtx({ hasUI: false, mode: "print" });

		mock.handlers.get("session_start")?.({}, ctx);
		expect(setFooter).not.toHaveBeenCalled();
	});

	it("restores the built-in footer on /divider", async () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter, notify } = createCtx();

		mock.handlers.get("session_start")?.({}, ctx);
		await mock.commands.get("divider")?.handler("", ctx);

		expect(setFooter).toHaveBeenLastCalledWith(undefined);
		expect(notify).toHaveBeenCalled();
	});

	it("refuses to toggle outside the terminal", async () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter, notify } = createCtx({ hasUI: false, mode: "print" });

		await mock.commands.get("divider")?.handler("", ctx);

		expect(setFooter).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Status dividers need the interactive terminal.",
			"info"
		);
	});

	it("removes the footer on session shutdown", () => {
		const mock = createMockPi();
		extensionDivider(mock.pi);
		const { ctx, setFooter } = createCtx();

		mock.handlers.get("session_start")?.({}, ctx);
		mock.handlers.get("session_shutdown")?.({}, ctx);

		expect(setFooter).toHaveBeenLastCalledWith(undefined);
	});
});
