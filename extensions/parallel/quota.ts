import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A unit of Parallel usage.
 *
 * `queries` is the billing-relevant request count: one per Search request,
 * one per URL for Extract. `usd` is the estimated cost of those requests.
 */
export interface QuotaCost {
	queries: number;
	usd: number;
	searchRequests?: number;
	extractUrls?: number;
}

/** Durable month-to-date Parallel usage. One file per agent install. */
export interface QuotaLedger {
	version: 1;
	/** `YYYY-MM`. A ledger from any other month is discarded. */
	month: string;
	queries: number;
	usd: number;
	searchRequests: number;
	extractUrls: number;
	updatedAt: string;
}

export interface QuotaLimits {
	softLimitQueries: number;
	hardLimitQueries: number;
	hardLimitUsd: number;
}

export interface QuotaDecision {
	/** The ledger after the reservation (or the current ledger when blocked). */
	ledger: QuotaLedger;
	/** False when the reservation would cross a hard limit. */
	allowed: boolean;
	/** Human-readable explanation when `allowed` is false. */
	reason?: string;
	/** True when the resulting usage crosses the soft limit. */
	softExceeded: boolean;
}

/** Thrown before any network call when a request would exceed a hard limit. */
export class QuotaExceededError extends Error {
	readonly ledger: QuotaLedger;
	readonly reason: string;

	constructor(reason: string, ledger: QuotaLedger) {
		super(reason);
		this.name = "QuotaExceededError";
		this.reason = reason;
		this.ledger = ledger;
	}
}

export const monthKey = (date: Date = new Date()): string =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

export const emptyLedger = (month: string = monthKey()): QuotaLedger => ({
	version: 1,
	month,
	queries: 0,
	usd: 0,
	searchRequests: 0,
	extractUrls: 0,
	updatedAt: new Date().toISOString(),
});

const applyCost = (ledger: QuotaLedger, cost: QuotaCost, sign: 1 | -1): QuotaLedger => ({
	...ledger,
	queries: Math.max(0, ledger.queries + sign * cost.queries),
	usd: Math.max(0, ledger.usd + sign * cost.usd),
	searchRequests: Math.max(0, ledger.searchRequests + sign * (cost.searchRequests ?? 0)),
	extractUrls: Math.max(0, ledger.extractUrls + sign * (cost.extractUrls ?? 0)),
	updatedAt: new Date().toISOString(),
});

export const decideQuota = (
	ledger: QuotaLedger,
	cost: QuotaCost,
	limits: QuotaLimits
): QuotaDecision => {
	const nextQueries = ledger.queries + cost.queries;
	const nextUsd = ledger.usd + cost.usd;
	const softExceeded = nextQueries > limits.softLimitQueries;

	if (nextQueries > limits.hardLimitQueries) {
		return {
			ledger,
			allowed: false,
			softExceeded,
			reason:
				`Parallel monthly request ceiling reached: ${ledger.queries.toLocaleString()} of ` +
				`${limits.hardLimitQueries.toLocaleString()} used, and this call needs ${cost.queries}. ` +
				`No request was sent.`,
		};
	}
	if (nextUsd > limits.hardLimitUsd) {
		return {
			ledger,
			allowed: false,
			softExceeded,
			reason:
				`Parallel monthly spend ceiling reached: ~${nextUsd.toFixed(4)} USD of ` +
				`${limits.hardLimitUsd.toFixed(2)} USD allowed. No request was sent.`,
		};
	}
	return { ledger: applyCost(ledger, cost, 1), allowed: true, softExceeded };
};

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 250;
const LOCK_WAIT_MS = 20;

/**
 * Month-to-date quota ledger backed by a single JSON file.
 *
 * `reserve` is an atomic read-modify-write guarded by a cross-process lock, so
 * concurrent tool calls (and concurrent Pi processes) cannot both slip under a
 * limit. `refund` reverses a reservation when the network request never
 * succeeded. Refunds clamp at zero.
 */
export class QuotaStore {
	constructor(
		private readonly path: string,
		private readonly limits: QuotaLimits
	) {}

	read(): QuotaLedger {
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<QuotaLedger>;
			if (parsed.month !== monthKey()) {
				return emptyLedger();
			}
			const base = emptyLedger(parsed.month);
			return {
				version: 1,
				month: parsed.month,
				queries: typeof parsed.queries === "number" && parsed.queries >= 0 ? parsed.queries : base.queries,
				usd: typeof parsed.usd === "number" && parsed.usd >= 0 ? parsed.usd : base.usd,
				searchRequests:
					typeof parsed.searchRequests === "number" && parsed.searchRequests >= 0
						? parsed.searchRequests
						: base.searchRequests,
				extractUrls:
					typeof parsed.extractUrls === "number" && parsed.extractUrls >= 0
						? parsed.extractUrls
						: base.extractUrls,
				updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : base.updatedAt,
			};
		} catch {
			return emptyLedger();
		}
	}

	/** Decide whether `cost` fits without mutating the ledger. */
	preview(cost: QuotaCost): QuotaDecision {
		return decideQuota(this.read(), cost, this.limits);
	}

	/** Atomically reserve `cost`. Throws {@link QuotaExceededError} when blocked. */
	reserve(cost: QuotaCost): QuotaDecision {
		return this.withLock(() => {
			const ledger = this.read();
			const decision = decideQuota(ledger, cost, this.limits);
			if (!decision.allowed) {
				throw new QuotaExceededError(decision.reason ?? "Parallel quota exceeded.", ledger);
			}
			this.write(decision.ledger);
			return decision;
		});
	}

	/** Reverse a reservation that did not result in a completed request. */
	refund(cost: QuotaCost): QuotaLedger {
		return this.withLock(() => {
			const next = applyCost(this.read(), cost, -1);
			this.write(next);
			return next;
		});
	}

	/** Clear the current month's ledger. */
	reset(): QuotaLedger {
		return this.withLock(() => {
			const next = emptyLedger();
			this.write(next);
			return next;
		});
	}

	private write(ledger: QuotaLedger): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, this.path);
	}

	private withLock<T>(fn: () => T): T {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const lockPath = `${this.path}.lock`;
		this.acquire(lockPath);
		try {
			return fn();
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
		}
	}

	private acquire(lockPath: string): void {
		for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
			try {
				mkdirSync(lockPath);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
				// Recover a lock left behind by a crashed process.
				try {
					if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
						rmSync(lockPath, { recursive: true, force: true });
						continue;
					}
				} catch {
					// Lock disappeared between the mkdir and stat; retry immediately.
				}
				sleepSync(LOCK_WAIT_MS);
			}
		}
		throw new Error(`Timed out waiting for the Parallel quota lock at ${lockPath}.`);
	}
}
