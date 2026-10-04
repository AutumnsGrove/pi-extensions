/**
 * Cost-ledger core.
 *
 * pi persists every assistant message's usage (tokens + exact provider cost)
 * into its session JSONL under `~/.pi/agent/sessions/<slug>/*.jsonl`. This
 * module turns that append-only log into windowed "runs" and renders them as a
 * markdown table. It has no dependency on pi's runtime so the CLI can reuse it.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface UsageRecord {
	timestamp: number; // epoch ms
	model: string;
	provider: string;
	usage: CostUsage;
}

export interface RunRecord {
	label: string;
	cwd: string;
	startedAt: string; // ISO
	stoppedAt: string; // ISO
	usage: CostUsage;
	/** Cost attributed per model within this run. */
	models: Record<string, number>;
	/** True for entries measured before the tracker existed. */
	manual?: boolean;
}

export interface ActiveRun {
	label: string;
	cwd: string;
	startedAt: string; // ISO
	/** Session file active when the run started, when known. */
	sessionFile?: string;
}

export interface LabelTotals {
	label: string;
	usage: CostUsage;
	runs: number;
}

// ---------------------------------------------------------------------------
// Usage math
// ---------------------------------------------------------------------------

export function zeroUsage(): CostUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

export function addUsage(a: CostUsage, b: CostUsage): CostUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
	};
}

export function normalizeUsage(raw: unknown): CostUsage {
	const u = (raw ?? {}) as Record<string, unknown>;
	const cost = (u.cost ?? {}) as Record<string, unknown>;
	const num = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	const input = num(u.input);
	const output = num(u.output);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: num(u.totalTokens) || input + output + cacheRead + cacheWrite,
		cost: num(cost.total),
	};
}

export function usageInWindow(
	records: readonly UsageRecord[],
	sinceMs: number,
	untilMs: number
): { usage: CostUsage; models: Record<string, number> } {
	let usage = zeroUsage();
	const models: Record<string, number> = {};
	for (const record of records) {
		if (record.timestamp < sinceMs || record.timestamp > untilMs) {
			continue;
		}
		usage = addUsage(usage, record.usage);
		const key = record.model || record.provider || "unknown";
		models[key] = (models[key] ?? 0) + record.usage.cost;
	}
	return { usage, models };
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override && override.length > 0) {
		return override.startsWith("~")
			? join(homedir(), override.slice(1))
			: override;
	}
	return join(homedir(), ".pi", "agent");
}

/** Mirrors pi's session-manager slug: `--Users-you-proj--`. */
export function sessionDirForCwd(cwd: string, agent = agentDir()): string {
	const resolved = resolve(cwd);
	const safePath = `--${resolved
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(agent, "sessions", safePath);
}

interface RawEntry {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		usage?: unknown;
		model?: string;
		provider?: string;
		timestamp?: number;
	};
	usage?: unknown;
	model?: string;
	provider?: string;
}

function entryTimestampMs(entry: RawEntry): number | undefined {
	const raw = entry.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw;
	}
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	const msgTs = entry.message?.timestamp;
	if (typeof msgTs === "number" && Number.isFinite(msgTs)) {
		return msgTs;
	}
	return undefined;
}

function recordFromEntry(entry: RawEntry): UsageRecord | undefined {
	const timestamp = entryTimestampMs(entry);
	if (timestamp === undefined) {
		return undefined;
	}
	if (
		entry.type === "message" &&
		entry.message?.usage &&
		(entry.message.role === "assistant" || entry.message.role === "toolResult")
	) {
		return {
			timestamp,
			model: entry.message.model ?? "",
			provider: entry.message.provider ?? "",
			usage: normalizeUsage(entry.message.usage),
		};
	}
	if (entry.type === "usage" && entry.usage) {
		return {
			timestamp,
			model: entry.model ?? "",
			provider: entry.provider ?? "",
			usage: normalizeUsage(entry.usage),
		};
	}
	if (
		(entry.type === "compaction" || entry.type === "branch_summary") &&
		entry.usage
	) {
		return {
			timestamp,
			model: entry.model ?? "",
			provider: entry.provider ?? "",
			usage: normalizeUsage(entry.usage),
		};
	}
	return undefined;
}

/** Read every usage-bearing entry from a single session JSONL file. */
export function readUsageFromFile(filePath: string): UsageRecord[] {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const out: UsageRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			continue;
		}
		let entry: RawEntry;
		try {
			entry = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		const record = recordFromEntry(entry);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

/** Read every usage entry from all sessions belonging to a project cwd. */
export function readUsageForCwd(cwd: string, agent = agentDir()): UsageRecord[] {
	const dir = sessionDirForCwd(cwd, agent);
	if (!existsSync(dir)) {
		return [];
	}
	const out: UsageRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) {
			continue;
		}
		out.push(...readUsageFromFile(join(dir, name)));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Ledger persistence
// ---------------------------------------------------------------------------

export function costStateDir(agent = agentDir()): string {
	return join(agent, "cost-tracker");
}

function activePath(agent = agentDir()): string {
	return join(costStateDir(agent), "active.json");
}

function runsPath(agent = agentDir()): string {
	return join(costStateDir(agent), "runs.json");
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function writeJson(filePath: string, value: unknown): void {
	ensureDir(dirname(filePath));
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, filePath);
}

export function readActive(agent = agentDir()): ActiveRun | undefined {
	const filePath = activePath(agent);
	if (!existsSync(filePath)) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ActiveRun | null;
		return parsed ?? undefined;
	} catch {
		return undefined;
	}
}

export function writeActive(run: ActiveRun, agent = agentDir()): void {
	writeJson(activePath(agent), run);
}

export function clearActive(agent = agentDir()): void {
	const filePath = activePath(agent);
	if (existsSync(filePath)) {
		try {
			unlinkSync(filePath);
		} catch {
			// Already gone; nothing to clear.
		}
	}
}

export function readRuns(agent = agentDir()): RunRecord[] {
	const filePath = runsPath(agent);
	if (!existsSync(filePath)) {
		return [];
	}
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RunRecord[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function appendRun(run: RunRecord, agent = agentDir()): void {
	const runs = readRuns(agent);
	runs.push(run);
	writeJson(runsPath(agent), runs);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUsd(value: number): string {
	if (!Number.isFinite(value)) {
		return "$0.000";
	}
	if (value > 0 && value < 0.001) {
		return `$${value.toFixed(4)}`;
	}
	return `$${value.toFixed(3)}`;
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return `${Math.round(value)}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "0s";
	}
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/** Aggregate runs by label, sorted by cost descending. */
export function aggregateByLabel(runs: readonly RunRecord[]): LabelTotals[] {
	const byLabel = new Map<string, LabelTotals>();
	for (const run of runs) {
		const existing = byLabel.get(run.label) ?? {
			label: run.label,
			usage: zeroUsage(),
			runs: 0,
		};
		existing.usage = addUsage(existing.usage, run.usage);
		existing.runs += 1;
		byLabel.set(run.label, existing);
	}
	return [...byLabel.values()].sort((a, b) => b.usage.cost - a.usage.cost);
}

export function renderCostTable(runs: readonly RunRecord[]): string {
	const totals = aggregateByLabel(runs);
	const lines = ["| Extension | Cost | Runs |", "| --- | --- | --- |"];
	for (const entry of totals) {
		lines.push(`| ${entry.label} | ${formatUsd(entry.usage.cost)} | ${entry.runs} |`);
	}
	const grand = totals.reduce((acc, entry) => addUsage(acc, entry.usage), zeroUsage());
	lines.push(`| **Total** | **${formatUsd(grand.cost)}** | **${runs.length}** |`);
	return lines.join("\n");
}

export const COST_START = "<!-- COST:START -->";
export const COST_END = "<!-- COST:END -->";

/** Replace the block between the cost markers, appending it when absent. */
export function upsertCostBlock(markdown: string, table: string): string {
	const block = `${COST_START}\n${table}\n${COST_END}`;
	const start = markdown.indexOf(COST_START);
	const end = markdown.indexOf(COST_END);
	if (start !== -1 && end !== -1 && end > start) {
		const before = markdown.slice(0, start);
		const after = markdown.slice(end + COST_END.length);
		return `${before}${block}${after}`;
	}
	const separator = markdown.endsWith("\n") ? "" : "\n";
	return `${markdown}${separator}\n${block}\n`;
}

// ---------------------------------------------------------------------------
// Run lifecycle (shared by the extension and the CLI)
// ---------------------------------------------------------------------------

/** Costs measured by hand before the tracker existed, kept in the total. */
export const SEEDED_HISTORY: RunRecord[] = [
	seed("provider-pinning", 0.417),
	seed("parallel", 0.303),
	seed("extension-divider", 0.1),
	seed("thinking-box", 0.113),
	seed("pi-q-n-a", 0.228),
	// Built before the tracker existed. Actual session spend was $0.164, halved
	// to $0.082 to attribute only the cost-tracker work (the rest was lumen
	// research that belongs to semantic-search).
	seed("cost-tracker", 0.082),
];

function seed(label: string, cost: number): RunRecord {
	const usage = zeroUsage();
	usage.cost = cost;
	return {
		label,
		cwd: "",
		startedAt: "",
		stoppedAt: "",
		usage,
		models: {},
		manual: true,
	};
}

export function startRun(
	label: string,
	cwd: string,
	sessionFile?: string,
	agent = agentDir()
): ActiveRun {
	const run: ActiveRun = {
		label: label.trim() || defaultLabel(cwd),
		cwd: resolve(cwd),
		startedAt: new Date().toISOString(),
		sessionFile,
	};
	writeActive(run, agent);
	return run;
}

export interface FinalizeResult {
	run: RunRecord;
	records: number;
}

/** Sum the window, persist a finalized run, clear the active marker. */
export function stopRun(now = new Date(), agent = agentDir()): FinalizeResult | undefined {
	const active = readActive(agent);
	if (!active) {
		return undefined;
	}
	const sinceMs = Date.parse(active.startedAt);
	const untilMs = now.getTime();
	const records = readUsageForCwd(active.cwd, agent);
	const { usage, models } = usageInWindow(records, sinceMs, untilMs);
	const windowRecords = records.filter(
		(record) => record.timestamp >= sinceMs && record.timestamp <= untilMs
	).length;
	const run: RunRecord = {
		label: active.label,
		cwd: active.cwd,
		startedAt: active.startedAt,
		stoppedAt: now.toISOString(),
		usage,
		models,
	};
	appendRun(run, agent);
	clearActive(agent);
	return { run, records: windowRecords };
}

export function defaultLabel(cwd: string): string {
	const parts = resolve(cwd).split(/[/\\]/).filter(Boolean);
	return parts.at(-1) ?? "run";
}

export function allRunsWithHistory(agent = agentDir()): RunRecord[] {
	return [...SEEDED_HISTORY, ...readRuns(agent)];
}
