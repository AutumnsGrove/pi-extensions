import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ThemeLike } from "./layout.ts";
import { normalizeQuestions, QuestionnaireComponent } from "./questionnaire.ts";
import type { QuestionSpec, QuestionnaireResult } from "./schema.ts";

const theme: ThemeLike = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
};

function makeTui(): TUI {
	return {
		requestRender() {},
		terminal: { rows: 40, cols: 90 },
	} as unknown as TUI;
}

function mount(questions: QuestionSpec[]): {
	component: QuestionnaireComponent;
	result: () => QuestionnaireResult | undefined;
} {
	let captured: QuestionnaireResult | undefined;
	const component = new QuestionnaireComponent({
		tui: makeTui(),
		theme,
		questions: normalizeQuestions(questions),
		done: (value) => {
			captured = value;
		},
	});
	return { component, result: () => captured };
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const SPACE = " ";

describe("QuestionnaireComponent", () => {
	it("selects a single option with Enter", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] },
		]);
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ selections: ["Alpha"], skipped: false });
	});

	it("selects and submits a single option by number", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] },
		]);
		component.handleInput("2");
		expect(result()?.answers[0]).toMatchObject({ selections: ["Beta"], skipped: false });
	});

	it("focuses Type something by number without typing the digit", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		// Option 1, Type something is 2, Skip is unnumbered.
		component.handleInput("2");
		for (const char of "custom answer") component.handleInput(char);
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ custom: "custom answer", skipped: false });
	});

	it("toggles a multi-select option by number", () => {
		const { component, result } = mount([
			{
				id: "q",
				prompt: "Which?",
				multiSelect: true,
				options: [{ label: "Alpha" }, { label: "Beta" }],
			},
		]);
		component.handleInput("1"); // Alpha on
		component.handleInput("2"); // Beta on
		component.handleInput("2"); // Beta off
		component.handleInput(ENTER); // advance -> submit
		expect(result()?.answers[0]?.selections).toEqual(["Alpha"]);
	});

	it("types digits as text once the Type something row is focused", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		component.handleInput(DOWN); // Move onto Type something
		for (const char of "42") component.handleInput(char);
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ custom: "42" });
	});

	it("treats a number past the last row as freeform text", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		component.handleInput("9"); // no row 9 -> jump to Type something and type it
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ custom: "9" });
	});

	it("types straight into the Type something field and records it", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		// No selection step: typing focuses the field immediately.
		for (const char of "nope please") component.handleInput(char);
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ custom: "nope please", skipped: false });
	});

	it("toggles options in a multi-select question", () => {
		const { component, result } = mount([
			{
				id: "q",
				prompt: "Which?",
				multiSelect: true,
				options: [{ label: "Alpha" }, { label: "Beta" }],
			},
		]);
		component.handleInput(SPACE); // Alpha on
		component.handleInput(DOWN);
		component.handleInput(SPACE); // Beta on
		component.handleInput(SPACE); // Beta off
		component.handleInput(ENTER); // advance -> submit
		expect(result()?.answers[0]?.selections).toEqual(["Alpha"]);
	});

	it("skips a question from the Skip row", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		component.handleInput(DOWN); // Type something
		component.handleInput(DOWN); // Skip
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ selections: [], skipped: true });
	});

	it("types on the Type something row itself", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		component.handleInput(DOWN); // Move onto Type something
		for (const char of "inline answer") component.handleInput(char);
		component.handleInput(ENTER);
		expect(result()?.answers[0]).toMatchObject({ custom: "inline answer" });
	});

	it("attaches a note with n and carries it into the result", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		component.handleInput("\x0e"); // ctrl+n
		for (const char of "keep it loud") component.handleInput(char);
		component.handleInput(ENTER); // save note
		component.handleInput(ENTER); // select Alpha -> submit
		expect(result()?.answers[0]).toMatchObject({ selections: ["Alpha"], note: "keep it loud" });
	});

	it("interrupts on Escape without submitting answers", () => {
		const { component, result } = mount([
			{ id: "q", prompt: "Which?", options: [{ label: "Alpha" }] },
		]);
		component.handleInput(ESCAPE);
		expect(result()?.interrupted).toBe(true);
	});
});
