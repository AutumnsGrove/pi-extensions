import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderPin } from "./config.ts";
import type { EndpointCatalog, ProviderEndpoint } from "./endpoints.ts";
import {
	formatCount,
	formatDiscount,
	formatLatency,
	formatPercentiles,
	formatPrice,
	formatThroughput,
	formatUptime,
	pricePerMillion,
} from "./format.ts";

/** The slice of the theme the table needs. Structurally satisfied by Theme. */
export interface TableTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export type PinResult =
	| {
			action: "pin";
			tag: string;
			providerName: string;
			allowFallbacks: boolean;
			quantizations: string[];
	  }
	| { action: "clear" };

export interface ProviderTableOptions {
	modelId: string;
	pin?: ProviderPin;
	/** Last provider OpenRouter reported serving (x-provider-name). */
	lastServed?: string;
	load: () => Promise<EndpointCatalog>;
	/** Shown immediately while `load` refreshes in the background. */
	initial?: EndpointCatalog;
	theme: TableTheme;
	requestRender: () => void;
	done: (result: PinResult | undefined) => void;
}

type SortKey = "recommended" | "price" | "speed" | "latency" | "uptime";

const SORT_ORDER: SortKey[] = ["recommended", "price", "speed", "latency", "uptime"];

const SORT_LABEL: Record<SortKey, string> = {
	recommended: "recommended (cache)",
	price: "price",
	speed: "speed",
	latency: "latency",
	uptime: "uptime",
};

const nextSort = (key: SortKey): SortKey =>
	SORT_ORDER[(SORT_ORDER.indexOf(key) + 1) % SORT_ORDER.length] as SortKey;

const ascending = (a: number | undefined, b: number | undefined): number => {
	if (a === undefined && b === undefined) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	return a - b;
};

const descending = (a: number | undefined, b: number | undefined): number => {
	if (a === undefined && b === undefined) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	return b - a;
};

interface Column {
	id: string;
	title: string;
	core: boolean;
	align: "left" | "right";
	max: number;
	value: (endpoint: ProviderEndpoint) => string;
}

const COLUMNS: Column[] = [
	{ id: "provider", title: "Provider", core: true, align: "left", max: 24, value: (e) => e.providerName },
	{ id: "tag", title: "Tag", core: false, align: "left", max: 22, value: (e) => e.tag },
	{ id: "quant", title: "Quant", core: false, align: "left", max: 8, value: (e) => e.quantization ?? "—" },
	{ id: "prompt", title: "In$/M", core: true, align: "right", max: 9, value: (e) => formatPrice(e.pricing.prompt) },
	{ id: "completion", title: "Out$/M", core: true, align: "right", max: 9, value: (e) => formatPrice(e.pricing.completion) },
	{ id: "cacheRead", title: "C.R$/M", core: true, align: "right", max: 9, value: (e) => formatPrice(e.pricing.cacheRead) },
	{ id: "cacheWrite", title: "C.W$/M", core: false, align: "right", max: 9, value: (e) => formatPrice(e.pricing.cacheWrite) },
	{ id: "discount", title: "Disc", core: false, align: "right", max: 6, value: (e) => formatDiscount(e.pricing.discount) },
	{ id: "context", title: "Ctx", core: true, align: "right", max: 6, value: (e) => formatCount(e.contextLength) },
	{ id: "maxOut", title: "MaxOut", core: false, align: "right", max: 7, value: (e) => formatCount(e.maxCompletionTokens) },
	{ id: "throughput", title: "tok/s", core: true, align: "right", max: 6, value: (e) => formatThroughput(e.throughput) },
	{ id: "latency", title: "Lat", core: true, align: "right", max: 8, value: (e) => formatLatency(e.latency) },
	{ id: "uptime", title: "Up%", core: false, align: "right", max: 6, value: (e) => formatUptime(e.uptime) },
	{ id: "implicit", title: "Cache", core: true, align: "left", max: 5, value: (e) => (e.supportsImplicitCaching ? "yes" : "—") },
];

/** Optional columns are added left-to-right as width allows. */
const OPTIONAL_PRIORITY = [
	COLUMNS.findIndex((c) => c.id === "uptime"),
	COLUMNS.findIndex((c) => c.id === "discount"),
	COLUMNS.findIndex((c) => c.id === "tag"),
	COLUMNS.findIndex((c) => c.id === "quant"),
	COLUMNS.findIndex((c) => c.id === "maxOut"),
	COLUMNS.findIndex((c) => c.id === "cacheWrite"),
];

const MARKER_WIDTH = 2;
const MAX_VISIBLE = 14;

type Row = { kind: "default" } | { kind: "endpoint"; endpoint: ProviderEndpoint };

const sortEndpoints = (
	endpoints: ProviderEndpoint[],
	key: SortKey
): ProviderEndpoint[] => {
	const list = [...endpoints];
	switch (key) {
		case "recommended":
			list.sort(
				(a, b) =>
					Number(b.supportsImplicitCaching) - Number(a.supportsImplicitCaching) ||
					ascending(
						pricePerMillion(a.pricing.cacheRead),
						pricePerMillion(b.pricing.cacheRead)
					) ||
					ascending(
						pricePerMillion(a.pricing.prompt),
						pricePerMillion(b.pricing.prompt)
					) ||
					a.tag.localeCompare(b.tag)
			);
			break;
		case "price":
			list.sort(
				(a, b) =>
					ascending(
						pricePerMillion(a.pricing.prompt),
						pricePerMillion(b.pricing.prompt)
					) || a.tag.localeCompare(b.tag)
			);
			break;
		case "speed":
			list.sort(
				(a, b) =>
					descending(a.throughput?.p50, b.throughput?.p50) ||
					a.tag.localeCompare(b.tag)
			);
			break;
		case "latency":
			list.sort(
				(a, b) =>
					ascending(a.latency?.p50, b.latency?.p50) || a.tag.localeCompare(b.tag)
			);
			break;
		case "uptime":
			list.sort(
				(a, b) => descending(a.uptime, b.uptime) || a.tag.localeCompare(b.tag)
			);
			break;
	}
	return list;
};

const pad = (text: string, width: number, align: "left" | "right"): string => {
	const clipped =
		visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
	const gap = Math.max(0, width - visibleWidth(clipped));
	return align === "right" ? " ".repeat(gap) + clipped : clipped + " ".repeat(gap);
};

export class ProviderTableView implements Component {
	private readonly modelId: string;
	private readonly pinnedTag: string | undefined;
	private readonly lastServed: string | undefined;
	private readonly theme: TableTheme;
	private readonly load: () => Promise<EndpointCatalog>;
	private readonly requestRender: () => void;
	private readonly done: (result: PinResult | undefined) => void;

	private catalog: EndpointCatalog | undefined;
	private error: string | undefined;
	private loading = true;
	private completed = false;
	private selected = 0;
	private sortKey: SortKey = "recommended";
	private allowFallbacks: boolean;
	private filter = "";
	private filtering = false;

	constructor(options: ProviderTableOptions) {
		this.modelId = options.modelId;
		this.pinnedTag = options.pin?.tag;
		this.lastServed = options.lastServed;
		this.allowFallbacks = options.pin?.allowFallbacks ?? false;
		this.theme = options.theme;
		this.load = options.load;
		this.requestRender = options.requestRender;
		this.done = options.done;
		if (options.initial) {
			this.catalog = options.initial;
			this.clampSelection();
		}
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		try {
			const catalog = await this.load();
			this.catalog = catalog;
			this.error = undefined;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.clampSelection();
			if (!this.completed) {
				this.requestRender();
			}
		}
	}

	private finish(result: PinResult | undefined): void {
		if (this.completed) {
			return;
		}
		this.completed = true;
		this.done(result);
	}

	private visibleEndpoints(): ProviderEndpoint[] {
		if (!this.catalog) {
			return [];
		}
		const needle = this.filter.trim().toLowerCase();
		const list =
			needle === ""
				? this.catalog.endpoints
				: this.catalog.endpoints.filter(
						(endpoint) =>
							endpoint.tag.toLowerCase().includes(needle) ||
							endpoint.providerName.toLowerCase().includes(needle) ||
							(endpoint.quantization ?? "").toLowerCase().includes(needle)
					);
		return sortEndpoints(list, this.sortKey);
	}

	private visibleRows(): Row[] {
		const rows: Row[] = this.filter.trim() === "" ? [{ kind: "default" }] : [];
		for (const endpoint of this.visibleEndpoints()) {
			rows.push({ kind: "endpoint", endpoint });
		}
		return rows;
	}

	private clampSelection(): void {
		const count = this.visibleRows().length;
		this.selected = count === 0 ? 0 : Math.min(this.selected, count - 1);
	}

	private move(delta: number): void {
		const count = this.visibleRows().length;
		if (count === 0) {
			return;
		}
		this.selected = Math.min(count - 1, Math.max(0, this.selected + delta));
	}

	private choose(): void {
		const row = this.visibleRows()[this.selected];
		if (!row) {
			return;
		}
		if (row.kind === "default") {
			this.finish({ action: "clear" });
			return;
		}
		const endpoint = row.endpoint;
		this.finish({
			action: "pin",
			tag: endpoint.tag,
			providerName: endpoint.providerName,
			allowFallbacks: this.allowFallbacks,
			quantizations:
				endpoint.quantization && endpoint.quantization !== "unknown"
					? [endpoint.quantization]
					: [],
		});
	}

	handleInput(data: string): void {
		if (this.filtering) {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
				this.filtering = false;
			} else if (matchesKey(data, Key.backspace)) {
				this.filter = this.filter.slice(0, -1);
			} else if (data.length === 1 && data >= " " && data !== "\u007f") {
				this.filter += data;
			} else {
				return;
			}
			this.selected = 0;
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.move(-1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.move(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.move(-MAX_VISIBLE);
		} else if (matchesKey(data, Key.pageDown)) {
			this.move(MAX_VISIBLE);
		} else if (matchesKey(data, Key.home)) {
			this.selected = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selected = Math.max(0, this.visibleRows().length - 1);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.choose();
			return;
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
			this.finish(undefined);
			return;
		} else if (matchesKey(data, "f")) {
			this.allowFallbacks = !this.allowFallbacks;
		} else if (matchesKey(data, "s")) {
			this.sortKey = nextSort(this.sortKey);
			this.selected = 0;
		} else if (matchesKey(data, "/")) {
			this.filtering = true;
		} else if (matchesKey(data, "d")) {
			this.finish({ action: "clear" });
			return;
		} else {
			return;
		}
		this.requestRender();
	}

	invalidate(): void {
		// Rendering is recomputed from scratch each frame.
	}

	private layout(
		rows: Row[],
		width: number
	): { columns: Column[]; widths: number[] } {
		const widths = COLUMNS.map((column) => {
			let widest = column.title.length;
			for (const row of rows) {
				if (row.kind === "endpoint") {
					widest = Math.max(widest, visibleWidth(column.value(row.endpoint)));
				}
			}
			return Math.min(column.max, widest);
		});
		const tableWidth = (indices: number[]): number =>
			MARKER_WIDTH + 1 + indices.reduce((sum, i) => sum + (widths[i] ?? 0), 0) + 2 * (indices.length - 1);
		const chosen: number[] = [];
		COLUMNS.forEach((column, index) => {
			if (column.core) {
				chosen.push(index);
			}
		});
		for (const index of OPTIONAL_PRIORITY) {
			if (index < 0 || chosen.includes(index)) {
				continue;
			}
			if (tableWidth([...chosen, index]) <= width) {
				chosen.push(index);
			}
		}
		chosen.sort((a, b) => a - b);
		return {
			columns: chosen.map((i) => COLUMNS[i] as Column),
			widths: chosen.map((i) => widths[i] ?? 0),
		};
	}

	private finishLine(line: string, selected: boolean, width: number): string {
		const clipped =
			visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
		const padded = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		return selected ? this.theme.bg("selectedBg", padded) : padded;
	}

	private headerLine(columns: Column[], widths: number[], width: number): string {
		const cells = columns
			.map((column, i) => pad(column.title, widths[i] ?? 0, column.align))
			.join("  ");
		return this.theme.fg(
			"muted",
			truncateToWidth(`${" ".repeat(MARKER_WIDTH + 1)}${cells}`, width, "…")
		);
	}

	private rowLine(
		row: Row,
		selected: boolean,
		columns: Column[],
		widths: number[],
		width: number
	): string {
		if (row.kind === "default") {
			const color = this.pinnedTag ? "muted" : "accent";
			const label = this.pinnedTag
				? "Default routing (no pin)"
				: "Default routing (no pin) — tap Enter to let OpenRouter choose";
			return this.finishLine(
				`  ${this.theme.fg(color, label)}`,
				selected,
				width
			);
		}
		const endpoint = row.endpoint;
		const pinned = this.pinnedTag === endpoint.tag;
		const served =
			this.lastServed !== undefined && endpoint.providerName === this.lastServed;
		const marks =
			(pinned ? this.theme.fg("success", "●") : " ") +
			(served ? this.theme.fg("accent", "✓") : " ");
		const cells = columns
			.map((column, i) => pad(column.value(endpoint), widths[i] ?? 0, column.align))
			.join("  ");
		return this.finishLine(`${marks} ${cells}`, selected, width);
	}

	private window(count: number): { start: number; end: number } {
		if (count <= MAX_VISIBLE) {
			return { start: 0, end: count };
		}
		const start = Math.min(
			Math.max(0, this.selected - Math.floor(MAX_VISIBLE / 2)),
			count - MAX_VISIBLE
		);
		return { start, end: start + MAX_VISIBLE };
	}

	private detailLines(row: Row | undefined, width: number): string[] {
		const theme = this.theme;
		if (!row) {
			return [theme.fg("muted", "No providers match the filter.")];
		}
		if (row.kind === "default") {
			return [
				theme.fg(
					"muted",
					truncateToWidth(
						"No pin: OpenRouter may route each request to a different provider, which cools the prompt cache.",
						width,
						"…"
					)
				),
			];
		}
		const endpoint = row.endpoint;
		const lines: string[] = [];
		lines.push(
			truncateToWidth(
				`Selected: ${theme.bold(theme.fg("text", endpoint.providerName))}  ${theme.fg("muted", endpoint.tag)}`,
				width,
				"…"
			)
		);
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					`In ${formatPrice(endpoint.pricing.prompt)} · Out ${formatPrice(endpoint.pricing.completion)} · Cache R ${formatPrice(endpoint.pricing.cacheRead)} · Cache W ${formatPrice(endpoint.pricing.cacheWrite)} · Disc ${formatDiscount(endpoint.pricing.discount)}`
				),
				width,
				"…"
			)
		);
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					`Context ${formatCount(endpoint.contextLength)} · Max out ${formatCount(endpoint.maxCompletionTokens)} · Quant ${endpoint.quantization ?? "—"} · Uptime ${formatUptime(endpoint.uptime)}%`
				),
				width,
				"…"
			)
		);
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					`Throughput ${formatThroughput(endpoint.throughput)} tok/s · Latency ${formatLatency(endpoint.latency)}`
				),
				width,
				"…"
			)
		);
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					`p50/p75/p90/p99  speed ${formatPercentiles(endpoint.throughput, " t/s")}  latency ${formatPercentiles(endpoint.latency, "ms")}`
				),
				width,
				"…"
			)
		);
		lines.push(
			truncateToWidth(
				`Implicit caching: ${endpoint.supportsImplicitCaching ? theme.fg("success", "yes") : theme.fg("muted", "no")}`,
				width,
				"…"
			)
		);
		if (!endpoint.supportedParameters.includes("tools")) {
			lines.push(
				truncateToWidth(
					theme.fg("warning", "⚠ endpoint does not list tool support; pi needs tools"),
					width,
					"…"
				)
			);
		}
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					`Params: ${endpoint.supportedParameters.length > 0 ? endpoint.supportedParameters.join(", ") : "none listed"}`
				),
				width,
				"…"
			)
		);
		return lines;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(
			theme.bold(
				theme.fg("accent", truncateToWidth(`Pin provider · ${this.modelId}`, width, "…"))
			)
		);
		if (this.loading && this.catalog === undefined) {
			lines.push("");
			lines.push(theme.fg("muted", "Loading provider endpoints…"));
			lines.push("");
			lines.push(this.footer(width));
			return lines;
		}
		if (this.catalog === undefined) {
			lines.push("");
			lines.push(theme.fg("error", truncateToWidth(this.error ?? "No provider data.", width, "…")));
			lines.push(theme.fg("muted", "Pin without the table with: /pin <tag>"));
			lines.push("");
			lines.push(this.footer(width));
			return lines;
		}

		const rows = this.visibleRows();
		const { columns, widths } = this.layout(rows, width);
		lines.push(this.headerLine(columns, widths, width));
		const separator = columns.reduce(
			(sum, _column, i) => sum + (widths[i] ?? 0) + 2,
			MARKER_WIDTH + 1
		);
		lines.push(theme.fg("dim", "─".repeat(Math.max(0, Math.min(width, separator - 2)))));

		const view = this.window(rows.length);
		for (let i = view.start; i < view.end; i++) {
			const row = rows[i];
			if (row) {
				lines.push(this.rowLine(row, i === this.selected, columns, widths, width));
			}
		}
		if (rows.length > view.end - view.start) {
			lines.push(theme.fg("dim", `  ${this.selected + 1}/${rows.length}`));
		}
		if (this.loading) {
			lines.push(theme.fg("dim", "  refreshing…"));
		}

		lines.push("");
		lines.push(...this.detailLines(rows[this.selected], width));
		lines.push("");
		lines.push(this.footer(width));
		return lines;
	}

	private footer(width: number): string {
		const hint = `↑/↓ move · Enter pin · f fallback ${this.allowFallbacks ? "on" : "off"} · s sort ${SORT_LABEL[this.sortKey]} · / filter · d clear · Esc cancel`;
		const text = this.filtering ? `Filter: ${this.filter}▌` : hint;
		return this.theme.fg(this.filtering ? "accent" : "dim", truncateToWidth(text, width, "…"));
	}
}

export const createProviderTable = (
	options: ProviderTableOptions
): ProviderTableView => new ProviderTableView(options);
