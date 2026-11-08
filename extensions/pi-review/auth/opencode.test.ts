import { describe, expect, it, vi } from "vitest";
import { authorizeOpenCodeGo } from "./opencode.ts";

const session = {
	server: "https://opencode.ai/console",
	access: "session-token",
	refresh: "refresh",
	expiresIn: 3600,
	accountId: "acct",
	email: "dev@example.test",
	orgId: "org-1",
};

describe("authorizeOpenCodeGo", () => {
	it("signs in, provisions a per-repo key, and relays the device code", async () => {
		const capture: { notified: string[] } = { notified: [] };
		const signIn = vi.fn(async (interaction: { notify: (event: unknown) => void }) => {
			interaction.notify({
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://opencode.ai/auth/device",
				intervalSeconds: 5,
				expiresInSeconds: 600,
			});
			return session;
		});
		const provision = vi.fn(async () => "oc_sk_minted");

		const key = await authorizeOpenCodeGo({
			keyName: "pi-review-owner-repo",
			notify: (message) => capture.notified.push(message),
			signIn: signIn as never,
			provision: provision as never,
		});

		expect(key).toBe("oc_sk_minted");
		expect(capture.notified[0]).toContain("ABCD-1234");
		expect(capture.notified[0]).toContain("https://opencode.ai/auth/device");
		expect(capture.notified.at(-1)).toContain("Minting");
		expect(provision).toHaveBeenCalledWith("https://opencode.ai/console", "session-token", expect.objectContaining({ keyName: "pi-review-owner-repo", orgId: "org-1" }));
	});

	it("routes progress ticks away from notify and forwards the abort signal", async () => {
		const controller = new AbortController();
		const notified: string[] = [];
		const progress: string[] = [];
		const provision = vi.fn(async () => "oc_sk");
		const key = await authorizeOpenCodeGo({
			keyName: "k",
			notify: (message) => notified.push(message),
			progress: (message) => progress.push(message),
			signal: controller.signal,
			signIn: (async (interaction: { notify: (event: unknown) => void }) => {
				interaction.notify({ type: "progress", message: "Waiting for OpenCode Go sign-in…" });
				return session;
			}) as never,
			provision: provision as never,
		});

		expect(key).toBe("oc_sk");
		expect(progress).toEqual(["Waiting for OpenCode Go sign-in…"]);
		expect(notified.join(" ")).not.toContain("Waiting");
		expect((provision.mock.calls[0] as unknown[])[2]).toMatchObject({ signal: controller.signal });
	});

	it("omits orgId when the session has none", async () => {
		const provision = vi.fn(async () => "oc_sk");
		await authorizeOpenCodeGo({
			keyName: "k",
			notify: () => {},
			signIn: (async () => ({ ...session, orgId: undefined })) as never,
			provision: provision as never,
		});
		expect((provision.mock.calls[0] as unknown[])[2]).not.toHaveProperty("orgId");
	});

	it("propagates a failed sign-in", async () => {
		await expect(
			authorizeOpenCodeGo({
				keyName: "k",
				notify: () => {},
				signIn: (async () => {
					throw new Error("device code expired");
				}) as never,
				provision: (async () => "unused") as never,
			})
		).rejects.toThrow("device code expired");
	});
});
