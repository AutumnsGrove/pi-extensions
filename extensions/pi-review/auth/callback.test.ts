import { describe, expect, it } from "vitest";
import {
	CallbackCancelledError,
	CallbackTimeoutError,
	startCallbackServer,
} from "./callback.ts";

describe("startCallbackServer", () => {
	it("resolves with the code and validates state", async () => {
		const server = await startCallbackServer({ expectedState: "st-1" });
		try {
			expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
			const bad = await fetch(`${server.url}?code=c&state=wrong`);
			expect(bad.status).toBe(400);
			const good = await fetch(`${server.url}?code=CODE-1&state=st-1`);
			expect(good.status).toBe(200);
			expect(await server.waitForCode).toEqual({ code: "CODE-1", state: "st-1" });
		} finally {
			await server.close();
		}
	});

	it("rejects a request without a code", async () => {
		const server = await startCallbackServer();
		const response = await fetch(`${server.url}?state=x`);
		expect(response.status).toBe(400);
		await server.close();
	});

	it("accepts a code without state when no state is expected", async () => {
		const server = await startCallbackServer();
		await fetch(`${server.url}?code=CODE-2`);
		expect(await server.waitForCode).toEqual({ code: "CODE-2" });
		await server.close();
	});

	it("times out", async () => {
		const server = await startCallbackServer({ timeoutMs: 30 });
		await expect(server.waitForCode).rejects.toBeInstanceOf(CallbackTimeoutError);
		await server.close();
	});

	it("rejects a pending wait when closed", async () => {
		const server = await startCallbackServer();
		const pending = server.waitForCode;
		await server.close();
		await expect(pending).rejects.toBeInstanceOf(CallbackCancelledError);
	});
});
