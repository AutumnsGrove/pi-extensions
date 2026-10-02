import type { EndpointCatalog } from "./endpoints.ts";
import { readJsonFile, writeJsonAtomic } from "./config.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseCatalog = (raw: unknown): EndpointCatalog | undefined => {
	if (
		!isRecord(raw) ||
		typeof raw.modelId !== "string" ||
		typeof raw.fetchedAt !== "number" ||
		!Array.isArray(raw.endpoints)
	) {
		return undefined;
	}
	// The cache is only a convenience; the fetcher re-validates on refresh.
	return raw as unknown as EndpointCatalog;
};

const parseCache = (raw: unknown): EndpointCatalog[] => {
	if (!isRecord(raw) || !Array.isArray(raw.catalogs)) {
		return [];
	}
	return raw.catalogs
		.map(parseCatalog)
		.filter((catalog): catalog is EndpointCatalog => catalog !== undefined);
};

/**
 * In-memory catalog cache backed by a JSON file. The file makes `/pin` instant
 * and usable offline; a successful fetch always overwrites it.
 */
export class EndpointCache {
	private readonly memory = new Map<string, EndpointCatalog>();
	private readonly filePath: string | undefined;

	constructor(filePath?: string, private readonly ttlMs = 300_000) {
		this.filePath = filePath;
		if (filePath) {
			for (const catalog of readJsonFile(filePath, [], parseCache)) {
				this.memory.set(catalog.modelId, catalog);
			}
		}
	}

	get(modelId: string): EndpointCatalog | undefined {
		return this.memory.get(modelId);
	}

	isFresh(catalog: EndpointCatalog | undefined): boolean {
		return (
			catalog !== undefined && Date.now() - catalog.fetchedAt < this.ttlMs
		);
	}

	set(catalog: EndpointCatalog): void {
		this.memory.set(catalog.modelId, catalog);
		if (this.filePath) {
			writeJsonAtomic(this.filePath, { catalogs: [...this.memory.values()] });
		}
	}
}
