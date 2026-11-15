import { describe, expect, it } from "vitest";
import { appliedMarker, hasSummary, parseApplied, sanitize, SUMMARY_MARKER } from "./markers.ts";

describe("markers", () => {
	it("round-trips an applied list through a comment body", () => {
		const body = `${SUMMARY_MARKER}\n${appliedMarker(["lattice", "bug"])}\nprose`;
		expect(parseApplied(body)).toEqual(["bug", "lattice"]);
	});

	it("tells 'nothing recorded' from 'nothing owned'", () => {
		expect(parseApplied("no marker here")).toBeUndefined();
		expect(parseApplied(`${SUMMARY_MARKER}\n${appliedMarker([])}`)).toEqual([]);
	});

	it("refuses a marker it cannot parse rather than guessing", () => {
		expect(parseApplied('<!-- pi-tag:applied not-json -->')).toBeUndefined();
		expect(parseApplied('<!-- pi-tag:applied {"a":1} -->')).toBeUndefined();
		expect(parseApplied('<!-- pi-tag:applied ["ok", 3] -->')).toEqual(["ok"]);
	});

	it("recognises its own comment", () => {
		expect(hasSummary(`${SUMMARY_MARKER}\nhi`)).toBe(true);
		expect(hasSummary("hi")).toBe(false);
	});
});

describe("sanitize", () => {
	it("removes our markers from model text", () => {
		const text = `look ${SUMMARY_MARKER} and ${appliedMarker(["priority-high"])} here`;
		expect(sanitize(text)).toBe("look  and  here");
	});

	it("leaves ordinary text and other comments alone", () => {
		expect(sanitize("a <!-- comment --> b")).toBe("a <!-- comment --> b");
	});
});
