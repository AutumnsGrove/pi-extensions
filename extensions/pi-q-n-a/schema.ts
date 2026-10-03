import { Type, type Static } from "typebox";

/**
 * One selectable option. `value` is what the model receives back; `label` is
 * what the user reads. `preview` is an optional, deliberately small mockup:
 * ASCII layout, a short diagram, or a brief code snippet.
 */
export const OptionSchema = Type.Object({
	label: Type.String({ description: "Short display label, ideally 1-5 words." }),
	description: Type.Optional(
		Type.String({ description: "One short sentence shown under the label." })
	),
	value: Type.Optional(
		Type.String({ description: "Stable value returned when this option is chosen; defaults to the label." })
	),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional brief mockup shown beside the options: an ASCII layout, a small diagram, or a short code snippet. Use \\n for line breaks and keep it under ~20 lines. Hidden for multi-select questions.",
		})
	),
	previewLanguage: Type.Optional(
		Type.String({
			description:
				"Language used to syntax-highlight the preview, e.g. 'ts', 'python', 'json'. Omit for plain monospace, which is best for ASCII art and diagrams.",
		})
	),
	recommended: Type.Optional(
		Type.Boolean({
			description: "Mark this option as the suggested choice; the UI shows '(Recommended)'. At most one per question.",
		})
	),
});

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique id used to label the answer, e.g. 'scope'." }),
	label: Type.Optional(
		Type.String({ description: "Short tab label, e.g. 'Scope'. Defaults to Q1, Q2, ..." })
	),
	prompt: Type.String({ description: "The full question text shown to the user." }),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow more than one option to be selected (default false). Previews are not shown for multi-select questions.",
		})
	),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		maxItems: 5,
		description:
			"1-5 options. The UI always adds a 'Type something' choice (unless allowOther is false) and a 'Skip this question' row.",
	}),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Offer the 'Type something' choice (default true)." })
	),
});

export const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description: "One or more questions asked together in a single form.",
	}),
});

export type OptionSpec = Static<typeof OptionSchema>;
export type QuestionSpec = Static<typeof QuestionSchema>;
export type QuestionnaireParamsType = Static<typeof QuestionnaireParams>;

/** A question with defaults applied, ready for the UI. */
export interface NormalizedQuestion extends QuestionSpec {
	label: string;
	allowOther: boolean;
	multiSelect: boolean;
}

export interface AnswerRecord {
	id: string;
	/** Selected option values. */
	selections: string[];
	/** Text typed into the "Type something" row. */
	custom?: string;
	/** Free-text note the user attached to this question. */
	note?: string;
	skipped: boolean;
}

export interface QuestionnaireResult {
	questions: NormalizedQuestion[];
	answers: AnswerRecord[];
	interrupted: boolean;
}

export type QuestionnaireDetails = QuestionnaireResult;
