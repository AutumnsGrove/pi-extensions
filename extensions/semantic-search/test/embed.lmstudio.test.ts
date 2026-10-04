import { describe, expect, it } from "vitest";
import { EmbedError } from "../src/embed/types.ts";
import { createLMStudioEmbedder } from "../src/embed/lmstudio.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface Call {
	url: string;
	body: { model: string; input: string[] };
}

function mockFetch(
	handler: (call: Call, index: number) => Response
): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Call["body"],
		};
		calls.push(call);
		return handler(call, calls.length - 1);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("LMStudioEmbedder", () => {
	it("embeds and sorts out-of-order responses by index", async () => {
		const { fetchImpl, calls } = mockFetch(() =>
			jsonResponse({
				data: [
					{ index: 1, embedding: [3, 4] },
					{ index: 0, embedding: [1, 2] },
				],
			})
		);
		const embedder = createLMStudioEmbedder({
			model: "nomic",
			dimensions: 2,
			fetchImpl,
		});
		expect(await embedder.embed(["a", "b"])).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(calls[0]?.url).toBe("http://localhost:1234/v1/embeddings");
		expect(embedder.modelName).toBe("nomic");
	});

	it("splits into batches", async () => {
		const { fetchImpl, calls } = mockFetch((call) =>
			jsonResponse({
				data: call.body.input.map((text, index) => ({
					index,
					embedding: [text.length],
				})),
			})
		);
		const embedder = createLMStudioEmbedder({
			model: "m",
			dimensions: 1,
			batchSize: 2,
			fetchImpl,
		});
		const vectors = await embedder.embed(["a", "bb", "ccc"]);
		expect(calls).toHaveLength(2);
		expect(vectors.map((v) => v[0])).toEqual([1, 2, 3]);
	});

	it("retries 5xx and surfaces 4xx", async () => {
		const retry = mockFetch((_call, index) =>
			index === 0
				? jsonResponse({}, 500)
				: jsonResponse({ data: [{ index: 0, embedding: [9] }] })
		);
		const retrying = createLMStudioEmbedder({
			model: "m",
			dimensions: 1,
			maxRetries: 2,
			baseDelayMs: 1,
			fetchImpl: retry.fetchImpl,
		});
		expect(await retrying.embed(["a"])).toEqual([[9]]);

		const failing = mockFetch(() => jsonResponse({}, 401));
		const embedder = createLMStudioEmbedder({
			model: "m",
			dimensions: 1,
			maxRetries: 3,
			baseDelayMs: 1,
			fetchImpl: failing.fetchImpl,
		});
		await expect(embedder.embed(["a"])).rejects.toBeInstanceOf(EmbedError);
		expect(failing.calls).toHaveLength(1);
	});
});
