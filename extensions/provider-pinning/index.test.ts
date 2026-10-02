import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import providerPinning from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
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
		registerShortcut() {},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands };
};

const writePin = (agentDir: string): void => {
	writeFileSync(
		join(agentDir, "provider-pins.json"),
		JSON.stringify({
			version: 1,
			pins: {
				"deepseek/deepseek-v4.1-flash": {
					tag: "deepseek",
					providerName: "DeepSeek",
					allowFallbacks: false,
					quantizations: [],
					updatedAt: "2026-10-02T00:00:00.000Z",
				},
			},
		}),
		"utf8"
	);
};

const context = (overrides: Record<string, unknown> = {}) => ({
	model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
	hasUI: false,
	ui: { setStatus: vi.fn(), notify: vi.fn() },
	...overrides,
});

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "provider-pinning-index-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	vi.useRealTimers();
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

describe("providerPinning extension", () => {
	it("injects the stored pin into OpenRouter request payloads", async () => {
		writePin(agentDir);
		const { pi, handlers } = createMockPi();
		providerPinning(pi);
		const payload = { model: "deepseek/deepseek-v4.1-flash" };
		const result = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload },
			context()
		);
		expect(result).toEqual({
			model: "deepseek/deepseek-v4.1-flash",
			provider: { only: ["deepseek"], allow_fallbacks: false },
		});
	});

	it("leaves non-OpenRouter requests untouched", async () => {
		writePin(agentDir);
		const { pi, handlers } = createMockPi();
		providerPinning(pi);
		const payload = { model: "deepseek/deepseek-v4.1-flash" };
		const result = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload },
			context({ model: { provider: "anthropic", id: "claude" } })
		);
		expect(result).toBeUndefined();
	});

	it("records the served provider from the stream and updates status", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T02:00:00Z"));
		writePin(agentDir);
		const { pi, handlers } = createMockPi();
		providerPinning(pi);
		const ctx = context();
		await handlers.get("provider_stream_event")?.(
			{
				type: "provider_stream_event",
				provider: "openrouter",
				api: "openai-completions",
				model: "deepseek/deepseek-v4.1-flash",
				data: { provider: "DeepSeek" },
			},
			ctx
		);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"openrouter-pin",
			"pin: DeepSeek · DS peak 2h0m"
		);
	});

	it("shows the off-peak badge outside DeepSeek's peak windows", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T11:00:00Z"));
		writePin(agentDir);
		const { pi, handlers } = createMockPi();
		providerPinning(pi);
		const ctx = context();
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"openrouter-pin",
			"pin: DeepSeek · DS off-peak 14h0m"
		);
	});

	it("nudges toward /provider when a model is chosen without a pin", async () => {
		const { pi, handlers } = createMockPi();
		providerPinning(pi);
		const ctx = context();
		await handlers.get("model_select")?.(
			{
				type: "model_select",
				source: "set",
				model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
				previousModel: undefined,
			},
			ctx
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"No provider pin for deepseek/deepseek-v4.1-flash · /provider to pin",
			"info"
		);
	});

	it("clears the pin through /pin off", async () => {
		writePin(agentDir);
		const { pi, commands } = createMockPi();
		providerPinning(pi);
		const ctx = context();
		await commands.get("pin")?.handler("off", ctx);
		const saved = JSON.parse(
			readFileSync(join(agentDir, "provider-pins.json"), "utf8")
		) as { pins: Record<string, unknown> };
		expect(saved.pins).toEqual({});
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cleared provider pin for deepseek/deepseek-v4.1-flash",
			"info"
		);
	});
});
