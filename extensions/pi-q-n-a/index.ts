import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { activeBlockers, beginBlocker, isBlocked, PI_QNA_TOOL } from "../_shared/blockers.ts";
import { QuestionnaireParams, type QuestionnaireDetails, type QuestionnaireResult } from "./schema.ts";
import {
	answerText,
	buildModelContent,
	normalizeQuestions,
	QuestionnaireComponent,
} from "./questionnaire.ts";

const TOOL_NAME = PI_QNA_TOOL;

const DESCRIPTION = [
	"Ask the user one or more multiple-choice questions and wait for their answers.",
	"Use when you need a decision, preference, or clarification only the user can give, especially when there are concrete options to compare.",
	"Each question has 1-5 options. The UI always adds a 'Type something' choice and a 'Skip this question' row, so do not add those yourself.",
	"Set multiSelect to let the user pick several options; nothing selected plus Enter is a skip.",
	"Add a short preview to an option when a visual helps: an ASCII layout, a small diagram, or a brief code snippet. Previews are shown beside the options and are hidden for multiSelect questions.",
	"Mark at most one option per question as recommended when you have a clear suggestion.",
	"The user may skip any question and submit partially; do not assume every question was answered.",
].join(" ");

const PROMPT_GUIDELINES = [
	"User notes attached to answers from pi-q-n-a are authoritative context: incorporate them into your work and never ignore or contradict them.",
	"pi-q-n-a is a hard blocker: while its form is open nothing else runs. Never call it alongside other tools or expect the session to continue in the background.",
];

export default function piQnA(pi: ExtensionAPI) {
	// Backstop for every other extension: while a question is open, no tool may
	// start. A concurrent run (for example one woken by a background job) would
	// otherwise keep working behind the form instead of waiting for an answer.
	// `terminate` also ends that run's tool batch so it cannot slip one more
	// request in after the blocked call.
	pi.on("tool_call", () => {
		if (!isBlocked()) return;
		return {
			block: true,
			terminate: true,
			reason: `${activeBlockers().join(", ")} is waiting for the user. The session is blocked until the question is answered.`,
		};
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask user",
		description: DESCRIPTION,
		promptSnippet: "Ask the user one or more multiple-choice questions with an optional preview.",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: QuestionnaireParams,
		exposure: "model-only",
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params.questions ?? []);
			if (questions.length === 0) {
				return errorResult("No questions were provided.");
			}

			if (ctx.mode !== "tui") {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `${TOOL_NAME} needs pi's interactive terminal UI. Ask the user these questions in plain text instead.`,
						},
					],
					details: { questions, answers: [], interrupted: false } satisfies QuestionnaireDetails,
				};
			}

			// Publish the blocker for exactly as long as the form is on screen.
			// Every turn-triggering extension checks this flag; the `tool_call`
			// handler above enforces it for everyone else.
			const release = beginBlocker(TOOL_NAME);
			let result: QuestionnaireResult;
			try {
				result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _keybindings, done) =>
					new QuestionnaireComponent({ tui, theme, questions, done })
				);
			} finally {
				release();
			}

			// Escape means "stop what you are doing", exactly like pressing Escape
			// during any other pi tool. Abort the turn instead of letting the model
			// act on a half-filled form. `terminate` is the backstop: aborting the
			// stream alone still let the model answer the empty result and continue.
			if (result.interrupted) ctx.abort();

			return {
				content: [{ type: "text", text: buildModelContent(questions, result.answers, result.interrupted) }],
				details: {
					questions,
					answers: result.answers,
					interrupted: result.interrupted,
				} satisfies QuestionnaireDetails,
				...(result.interrupted ? { terminate: true } : {}),
			};
		},

		renderCall(args, theme, _context) {
			const questions = args.questions ?? [];
			const labels = questions
				.map((question, index) => question.label?.trim() || `Q${index + 1}`)
				.join(", ");
			let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireDetails | undefined;
			if (!details) {
				const block = result.content[0];
				return new Text(block?.type === "text" ? block.text : "", 0, 0);
			}
			if (details.interrupted) {
				return new Text(theme.fg("warning", "■ interrupted"), 0, 0);
			}

			const lines: string[] = [theme.fg("dim", TOOL_NAME)];
			for (const question of details.questions) {
				const answer = details.answers.find((candidate) => candidate.id === question.id);
				lines.push(
					`  ${theme.fg("accent", question.label)}: ${theme.fg("text", answerText(question, answer))}`
				);
				const note = answer?.note?.trim();
				if (note) {
					lines.push(`    ${theme.fg("muted", "note: ")}${theme.fg("accent", note)}`);
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

function errorResult(message: string): {
	isError: true;
	content: { type: "text"; text: string }[];
	details: QuestionnaireDetails;
} {
	return {
		isError: true,
		content: [{ type: "text", text: message }],
		details: { questions: [], answers: [], interrupted: false },
	};
}
