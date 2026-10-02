import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	QuotaExceededError,
	QuotaStore,
	decideQuota,
	emptyLedger,
	monthKey,
	type QuotaLimits,
} from "./quota.ts";

const limits: QuotaLimits = {
	softLimitQueries: 3_000,
	hardLimitQueries: 4_000,
	hardLimitUsd: 4,
};

const tempDirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "parallel-quota-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("monthKey", () => {
	it("formats as YYYY-MM with a zero-padded month", () => {
		expect(monthKey(new Date(2026, 0, 15))).toBe("2026-01");
		expect(monthKey(new Date(2026, 9, 2))).toBe("2026-10");
	});
});

describe("decideQuota", () => {
	it("allows a request within both limits", () => {
		const decision = decideQuota(emptyLedger(), { queries: 1, usd: 0.001 }, limits);
		expect(decision.allowed).toBe(true);
		expect(decision.softExceeded).toBe(false);
		expect(decision.ledger.queries).toBe(1);
	});

	it("blocks before crossing the hard request ceiling", () => {
		const ledger = { ...emptyLedger(), queries: 3_999 };
		const decision = decideQuota(ledger, { queries: 2, usd: 0.002 }, limits);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("request ceiling");
		expect(decision.ledger.queries).toBe(3_999);
	});

	it("warns at the soft limit but still allows", () => {
		const ledger = { ...emptyLedger(), queries: 3_000 };
		const decision = decideQuota(ledger, { queries: 1, usd: 0.001 }, limits);
		expect(decision.allowed).toBe(true);
		expect(decision.softExceeded).toBe(true);
		expect(decision.ledger.queries).toBe(3_001);
	});

	it("blocks before crossing the hard spend ceiling", () => {
		const ledger = { ...emptyLedger(), usd: 3.9995 };
		const decision = decideQuota(ledger, { queries: 1, usd: 0.001 }, limits);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("spend ceiling");
	});

	it("tracks search and extract breakdowns", () => {
		const decision = decideQuota(
			emptyLedger(),
			{ queries: 3, usd: 0.003, extractUrls: 3 },
			limits
		);
		expect(decision.ledger.extractUrls).toBe(3);
		expect(decision.ledger.searchRequests).toBe(0);
	});
});

describe("QuotaStore", () => {
	const cost = { queries: 1, usd: 0.001, searchRequests: 1 };

	it("reserves, persists, and refunds", () => {
		const path = join(tempDir(), "quota.json");
		const store = new QuotaStore(path, limits);
		const reserved = store.reserve(cost);
		expect(reserved.ledger.queries).toBe(1);
		expect(store.read().usd).toBeCloseTo(0.001);

		const refunded = store.refund(cost);
		expect(refunded.queries).toBe(0);
		expect(refunded.usd).toBe(0);
	});

	it("throws QuotaExceededError rather than overshooting", () => {
		const path = join(tempDir(), "quota.json");
		const store = new QuotaStore(path, { ...limits, hardLimitQueries: 1, softLimitQueries: 1 });
		store.reserve(cost);
		expect(() => store.reserve(cost)).toThrow(QuotaExceededError);
		expect(store.read().queries).toBe(1);
	});

	it("resets a stale ledger from a previous month", () => {
		const path = join(tempDir(), "quota.json");
		const store = new QuotaStore(path, limits);
		store.reserve(cost);
		// Simulate a month rollover by rewriting the file with an old month.
		const old = { ...store.read(), month: "2000-01", queries: 9_999, usd: 99 };
		writeJson(path, old);
		expect(store.read().queries).toBe(0);
	});

	it("does not refund below zero", () => {
		const path = join(tempDir(), "quota.json");
		const store = new QuotaStore(path, limits);
		store.refund(cost);
		expect(store.read().queries).toBe(0);
		expect(store.read().usd).toBe(0);
	});
});

const writeJson = (path: string, value: unknown): void => {
	writeFileSync(path, JSON.stringify(value), "utf-8");
};
