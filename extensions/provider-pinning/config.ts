import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A chosen upstream provider for one OpenRouter model. */
export interface ProviderPin {
	/** Provider slug as OpenRouter uses it in `provider.only` (e.g. "deepseek", "morph/fp8"). */
	tag: string;
	/** Human-readable provider name for status text. */
	providerName: string;
	/** When false, the request uses `only` with no fallbacks: exactly this provider or nothing. */
	allowFallbacks: boolean;
	/** Optional quantization constraint (e.g. ["fp8"]). Empty for "unknown" quant. */
	quantizations: string[];
	/** ISO timestamp of the last change. */
	updatedAt: string;
}

export interface PinsFile {
	version: 1;
	pins: Record<string, ProviderPin>;
}

export const emptyPins = (): PinsFile => ({ version: 1, pins: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const isProviderPin = (value: unknown): value is ProviderPin =>
	isRecord(value) &&
	typeof value.tag === "string" &&
	value.tag.length > 0 &&
	typeof value.providerName === "string" &&
	typeof value.allowFallbacks === "boolean" &&
	Array.isArray(value.quantizations) &&
	value.quantizations.every((item) => typeof item === "string") &&
	typeof value.updatedAt === "string";

/** Drop malformed entries instead of failing the whole file. */
export const parsePinsFile = (raw: unknown): PinsFile => {
	if (!isRecord(raw) || !isRecord(raw.pins)) {
		return emptyPins();
	}
	const pins: Record<string, ProviderPin> = {};
	for (const [model, value] of Object.entries(raw.pins)) {
		if (isProviderPin(value)) {
			pins[model] = value;
		}
	}
	return { version: 1, pins };
};

export const readJsonFile = <T>(
	path: string,
	fallback: T,
	parse: (raw: unknown) => T
): T => {
	try {
		if (!existsSync(path)) {
			return fallback;
		}
		return parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return fallback;
	}
};

export const writeJsonAtomic = (path: string, value: unknown): void => {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temp, path);
};

export const loadPins = (path: string): PinsFile =>
	readJsonFile(path, emptyPins(), parsePinsFile);

export const savePins = (path: string, data: PinsFile): void =>
	writeJsonAtomic(path, data);
