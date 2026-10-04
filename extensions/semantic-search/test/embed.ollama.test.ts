import { describe, expect, it } from "vitest";
import { EmbedError } from "../src/embed/types.ts";
import { createOllamaEmbedder } from "../src/embed/ollama.ts";

interface Call {
	url: string;
	body: { model: string; input: string[]; options?: { num_ctx: number } };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
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

describe("OllamaEmbedder", () => {
	it("embeds a single batch in order", async () => {
		const { fetchImpl, calls } = mockFetch(() =>
			jsonResponse({ embeddings: [[1, 2], [3, 4]] })
		);
		const embedder = createOllamaEmbedder({
			model: "m",
			dimensions: 2,
			fetchImpl,
		});
		const vectors = await embedder.embed(["a", "b"]);
		expect(vectors).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(calls[0]?.url).toBe("http://localhost:11434/api/embed");
		expect(embedder.dimensions).toBe(2);
		expect(embedder.modelName).toBe("m");
	});

	it("splits into batches and preserves order", async () => {
		const { fetchImpl, calls } = mockFetch((call) =>
			jsonResponse({
				embeddings: call.body.input.map((text) => [text.length]),
			})
		);
		const embedder = createOllamaEmbedder({
			model: "m",
			dimensions: 1,
			batchSize: 2,
			fetchImpl,
		});
		const vectors = await embedder.embed(["a", "bb", "ccc", "dddd", "eeeee"]);
		expect(calls).toHaveLength(3);
		expect(calls[0]?.body.input).toEqual(["a", "bb"]);
		expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
	});

	it("includes num_ctx when a context length is configured", async () => {
		const { fetchImpl, calls } = mockFetch(() => jsonResponse({ embeddings: [[1]] }));
		const embedder = createOllamaEmbedder({
			model: "m",
			dimensions: 1,
			contextLength: 8192,
			fetchImpl,
		});
		await embedder.embed(["a"]);
		expect(calls[0]?.body.options).toEqual({ num_ctx: 8192 });
	});

	it("retries transient 5xx errors", async () => {
		const { fetchImpl, calls } = mockFetch((_call, index) =>
			index === 0
				? jsonResponse({ error: "boom" }, 503)
				: jsonResponse({ embeddings: [[7]] })
		);
		const embedder = createOllamaEmbedder({
			model: "m",
			dimensions: 1,
			maxRetries: 2,
			baseDelayMs: 1,
			fetchImpl,
		});
		expect(await embedder.embed(["a"])).toEqual([[7]]);
		expect(calls).toHaveLength(2);
	});

	it("does not retry 4xx errors", async () => {
		const { fetchImpl, calls } = mockFetch(() =>
			jsonResponse({ error: "bad model" }, 404)
		);
		const embedder = createOllamaEmbedder({
			model: "m",
			dimensions: 1,
			maxRetries: 3,
			baseDelayMs: 1,
			fetchImpl,
		});
		await expect(embedder.embed(["a"])).rejects.toBeInstanceOf(EmbedError);
		expect(calls).toHaveLength(1);
	});

	it("returns no vectors for empty input", async () => {
		const { fetchImpl, calls } = mockFetch(() => jsonResponse({ embeddings: [] }));
		const embedder = createOllamaEmbedder({ model: "m", dimensions: 1, fetchImpl });
		expect(await embedder.embed([])).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});
