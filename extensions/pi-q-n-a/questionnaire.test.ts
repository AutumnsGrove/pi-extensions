import { describe, expect, it } from "vitest";
import {
	answerText,
	buildModelContent,
	normalizeQuestions,
	optionsFor,
	OTHER_VALUE,
	questionHasPreview,
	SKIP_VALUE,
} from "./questionnaire.ts";
import type { AnswerRecord, NormalizedQuestion, QuestionSpec } from "./schema.ts";

function makeQuestion(overrides: Partial<QuestionSpec> = {}): QuestionSpec {
	return {
		id: "id",
		prompt: "Which one?",
		options: [{ label: "Alpha" }, { label: "Beta" }],
		...overrides,
	};
}

function normalize(overrides: Partial<QuestionSpec> = {}): NormalizedQuestion {
	return normalizeQuestions([makeQuestion(overrides)])[0]!;
}

describe("normalizeQuestions", () => {
	it("fills in sequential tab labels", () => {
		const questions = normalizeQuestions([makeQuestion(), makeQuestion({ id: "b" })]);
		expect(questions.map((question) => question.label)).toEqual(["Q1", "Q2"]);
	});

	it("keeps an explicit label and trims it", () => {
		expect(normalize({ label: "  Scope  " }).label).toBe("Scope");
	});

	it("defaults allowOther on and multiSelect off", () => {
		const question = normalize();
		expect(question.allowOther).toBe(true);
		expect(question.multiSelect).toBe(false);
	});

	it("preserves explicit false values", () => {
		const question = normalize({ allowOther: false, multiSelect: true });
		expect(question.allowOther).toBe(false);
		expect(question.multiSelect).toBe(true);
	});
});

describe("optionsFor", () => {
	it("appends the inline Type something row then Skip", () => {
		const options = optionsFor(normalize());
		expect(options.map((option) => option.kind)).toEqual([
			"option",
			"option",
			"other",
			"skip",
		]);
		expect(options[2]?.value).toBe(OTHER_VALUE);
		expect(options[2]?.index).toBe(3);
		expect(options[3]?.value).toBe(SKIP_VALUE);
		expect(options[3]?.index).toBe(0);
	});

	it("carries values, descriptions, recommendations, and previews", () => {
		const options = optionsFor(
			normalize({
				options: [
					{
						label: "Postgres",
						value: "pg",
						description: "Relational",
						recommended: true,
						preview: "SELECT 1",
						previewLanguage: "sql",
					},
				],
			})
		);
		expect(options[0]).toMatchObject({
			value: "pg",
			label: "Postgres",
			description: "Relational",
			recommended: true,
			preview: "SELECT 1",
			previewLanguage: "sql",
		});
	});

	it("falls back to the label when no value is given", () => {
		expect(optionsFor(normalize())[0]?.value).toBe("Alpha");
	});
});

describe("questionHasPreview", () => {
	it("is true for a single-select question with a preview", () => {
		expect(questionHasPreview(normalize({ options: [{ label: "A", preview: "x" }] }))).toBe(true);
	});

	it("is false for multi-select questions", () => {
		expect(
			questionHasPreview(normalize({ multiSelect: true, options: [{ label: "A", preview: "x" }] }))
		).toBe(false);
	});

	it("is false without any previews", () => {
		expect(questionHasPreview(normalize())).toBe(false);
	});
});

describe("answerText", () => {
	it("maps selected values back to labels", () => {
		const question = normalize({ options: [{ label: "Alpha", value: "a" }, { label: "Beta" }] });
		const answer: AnswerRecord = { id: "id", selections: ["a", "Beta"], skipped: false };
		expect(answerText(question, answer)).toBe("Alpha, Beta");
	});

	it("includes custom text", () => {
		const question = normalize();
		const answer: AnswerRecord = {
			id: "id",
			selections: [],
			custom: "something else",
			skipped: false,
		};
		expect(answerText(question, answer)).toBe('"something else"');
	});

	it("reports skipped when nothing was chosen", () => {
		expect(answerText(normalize(), { id: "id", selections: [], skipped: true })).toBe("(skipped)");
		expect(answerText(normalize(), undefined)).toBe("(skipped)");
	});
});

describe("buildModelContent", () => {
	it("renders questions, answers, and notes on their own line", () => {
		const questions = normalizeQuestions([
			makeQuestion({ id: "db", prompt: "Which database?", label: "Database" }),
			makeQuestion({ id: "screens", prompt: "Which screens?" }),
		]);
		const answers: AnswerRecord[] = [
			{ id: "db", selections: ["Alpha"], skipped: false, note: "needs replication" },
			{ id: "screens", selections: [], skipped: true },
		];
		const content = buildModelContent(questions, answers, false);
		expect(content).toContain("Q: Which database?");
		expect(content).toContain("A: Alpha");
		expect(content).toContain("User note: needs replication");
		expect(content).toContain("A: (skipped)");
	});

	it("explains an interrupted questionnaire", () => {
		const content = buildModelContent(normalizeQuestions([makeQuestion()]), [], true);
		expect(content).toContain("interrupted");
	});
});
