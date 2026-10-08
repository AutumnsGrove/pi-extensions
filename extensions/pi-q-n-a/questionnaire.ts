import {
	Editor,
	type Component,
	type EditorTheme,
	Input,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { chooseLayout, composeColumns, padRight, renderPreviewBox, type ThemeLike } from "./layout.ts";
import type {
	AnswerRecord,
	NormalizedQuestion,
	QuestionnaireResult,
	QuestionSpec,
} from "./schema.ts";

/** Sentinel value for the inline "Type something" row. */
export const OTHER_VALUE = "__other__";
/** Sentinel value for the "Skip this question" row. */
export const SKIP_VALUE = "__skip__";

export interface RenderOption {
	kind: "option" | "other" | "skip";
	/** 1-based display number; 0 for the Skip row, which is not numbered. */
	index: number;
	value: string;
	label: string;
	description?: string;
	preview?: string;
	previewLanguage?: string;
	recommended?: boolean;
}

/** Apply the schema defaults the UI relies on. */
export function normalizeQuestions(questions: QuestionSpec[]): NormalizedQuestion[] {
	return questions.map((question, index) => ({
		...question,
		label: question.label?.trim() || `Q${index + 1}`,
		allowOther: question.allowOther !== false,
		multiSelect: question.multiSelect === true,
	}));
}

/** The navigable rows for a question: its options, the inline "Type something"
 * field, then the Skip row. */
export function optionsFor(question: NormalizedQuestion): RenderOption[] {
	const options: RenderOption[] = question.options.map((option, index) => {
		const rendered: RenderOption = {
			kind: "option",
			index: index + 1,
			value: option.value ?? option.label,
			label: option.label,
		};
		if (option.description) rendered.description = option.description;
		if (option.preview) rendered.preview = option.preview;
		if (option.previewLanguage) rendered.previewLanguage = option.previewLanguage;
		if (option.recommended) rendered.recommended = true;
		return rendered;
	});
	if (question.allowOther) {
		options.push({
			kind: "other",
			index: options.length + 1,
			value: OTHER_VALUE,
			label: "Type something.",
		});
	}
	options.push({ kind: "skip", index: 0, value: SKIP_VALUE, label: "Skip this question" });
	return options;
}

/** Whether a question should reserve a preview pane. Multi-select questions never do. */
export function questionHasPreview(question: NormalizedQuestion): boolean {
	return (
		!question.multiSelect &&
		question.options.some((option) => (option.preview ?? "").trim().length > 0)
	);
}

function optionLabel(question: NormalizedQuestion, value: string): string {
	const option = question.options.find((candidate) => (candidate.value ?? candidate.label) === value);
	return option ? option.label : value;
}

/** Human-readable answer for one question, used by the submit tab and transcript. */
export function answerText(question: NormalizedQuestion, answer: AnswerRecord | undefined): string {
	if (!answer) return "(skipped)";
	const parts: string[] = [];
	for (const value of answer.selections) {
		parts.push(optionLabel(question, value));
	}
	if (answer.custom) parts.push(`"${answer.custom}"`);
	return parts.length > 0 ? parts.join(", ") : "(skipped)";
}

/**
 * Model-facing transcript of the questionnaire. Notes are printed on their own
 * line so the model cannot miss them.
 */
export function buildModelContent(
	questions: NormalizedQuestion[],
	answers: AnswerRecord[],
	interrupted: boolean
): string {
	const byId = new Map(answers.map((answer) => [answer.id, answer]));
	const lines: string[] = [];
	if (interrupted) {
		lines.push("The user interrupted the questionnaire before submitting. No answers were submitted.");
		lines.push("");
	}
	for (const question of questions) {
		const answer = byId.get(question.id);
		lines.push(`Q: ${question.prompt}`);
		lines.push(`A: ${answerText(question, answer)}`);
		const note = answer?.note?.trim();
		if (note) lines.push(`User note: ${note}`);
	}
	return lines.join("\n");
}

type EditorMode = "nav" | "note";

export interface QuestionnaireComponentOptions {
	tui: TUI;
	theme: ThemeLike;
	questions: NormalizedQuestion[];
	done: (result: QuestionnaireResult) => void;
}

/**
 * The interactive questionnaire. Owns the keyboard while visible: tabs across
 * questions, a cursor per question, an always-visible "Type something" field
 * you can type into immediately, a note editor, and a submit tab that accepts
 * partial answers.
 */
export class QuestionnaireComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: ThemeLike;
	private readonly questions: NormalizedQuestion[];
	private readonly done: (result: QuestionnaireResult) => void;
	private readonly editor: Editor;
	private readonly input: Input;

	private currentTab = 0;
	private optionIndex = 0;
	private mode: EditorMode = "nav";
	private readonly selected = new Map<string, Set<string>>();
	private readonly custom = new Map<string, string>();
	private readonly notes = new Map<string, string>();
	private readonly skipped = new Set<string>();
	private cached?: string[];

	constructor(options: QuestionnaireComponentOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.questions = options.questions;
		this.done = options.done;

		const editorTheme: EditorTheme = {
			borderColor: (text) => this.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		};
		this.editor = new Editor(this.tui, editorTheme);
		this.editor.onSubmit = (value) => this.submitNote(value);

		this.input = new Input({
			prompt: "",
			placeholder: "Type something.",
			placeholderStyle: (text) => this.theme.fg("dim", text),
		});
	}

	handleInput(data: string): void {
		if (this.mode === "note") {
			if (matchesKey(data, Key.escape)) {
				this.mode = "nav";
				this.editor.setText("");
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.interrupt();
			return;
		}

		const multi = this.questions.length > 1;
		const onSubmitTab = this.currentTab === this.questions.length;

		if (onSubmitTab) {
			if (matchesKey(data, Key.enter)) {
				this.submit();
				return;
			}
			if (multi) {
				if (this.isNextTab(data)) this.moveTab(1);
				else if (this.isPrevTab(data)) this.moveTab(-1);
			}
			return;
		}

		const question = this.currentQuestion();
		if (!question) return;
		const options = optionsFor(question);
		const option = options[this.optionIndex];

		// The "Type something" row is a real text field. While the cursor sits on
		// it, every editing key belongs to the input; only navigation escapes it.
		if (option?.kind === "other") {
			if (matchesKey(data, Key.up)) {
				this.moveCursor(-1, options.length);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveCursor(1, options.length);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.advance();
				return;
			}
			if (multi && matchesKey(data, Key.tab)) {
				this.moveTab(1);
				return;
			}
			if (multi && matchesKey(data, Key.shift("tab"))) {
				this.moveTab(-1);
				return;
			}
			if (matchesKey(data, Key.ctrl("n"))) {
				this.openNote();
				return;
			}
			this.input.handleInput(data);
			this.persistInput();
			this.refresh();
			return;
		}

		if (multi) {
			if (this.isNextTab(data)) {
				this.moveTab(1);
				return;
			}
			if (this.isPrevTab(data)) {
				this.moveTab(-1);
				return;
			}
		}

		if (matchesKey(data, Key.up)) {
			this.moveCursor(-1, options.length);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveCursor(1, options.length);
			return;
		}
		if (matchesKey(data, Key.ctrl("n"))) {
			this.openNote();
			return;
		}

		if (question.multiSelect) {
			if (matchesKey(data, Key.space)) {
				if (option) this.activate(option, question);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (!option) return;
				if (option.kind === "skip") this.skip(question);
				else this.advance();
				return;
			}
		} else if (matchesKey(data, Key.enter)) {
			if (option) this.activate(option, question);
			return;
		}

		// A typed number picks that numbered row directly: a regular option is
		// chosen (and a single-select question advances), while the Type
		// something row is focused so the user can start typing. The digit is
		// consumed, never inserted as the first character of the answer.
		const number = /^([1-9])$/.exec(data);
		if (number) {
			const target = options.find(
				(candidate) => candidate.kind !== "skip" && candidate.index === Number(number[1])
			);
			if (target) {
				if (target.kind === "other") this.focusOther();
				else this.activate(target, question);
				return;
			}
		}

		// Typing anywhere jumps to the Type something row and starts the answer.
		if (question.allowOther && this.isPrintable(data)) {
			this.focusOtherAndType(data);
		}
	}

	render(width: number): string[] {
		if (this.cached) return this.cached;
		const w = Math.max(1, Math.floor(width));
		const lines: string[] = [this.border(w)];
		const multi = this.questions.length > 1;
		if (multi) {
			lines.push(...this.renderTabs(w));
			lines.push("");
		}
		if (this.currentTab === this.questions.length) {
			lines.push(...this.renderSubmit(w));
		} else {
			lines.push(...this.renderQuestion(w));
		}
		lines.push("");
		lines.push(...this.renderHelp(w));
		lines.push(this.border(w));
		this.cached = lines;
		return lines;
	}

	invalidate(): void {
		this.cached = undefined;
		this.editor.invalidate();
		this.input.invalidate();
	}

	private border(width: number): string {
		return this.theme.fg("borderMuted", "─".repeat(width));
	}

	private currentQuestion(): NormalizedQuestion | undefined {
		return this.questions[this.currentTab];
	}

	private selectionSet(id: string): Set<string> {
		let set = this.selected.get(id);
		if (!set) {
			set = new Set();
			this.selected.set(id, set);
		}
		return set;
	}

	private refresh(): void {
		this.cached = undefined;
		this.tui.requestRender();
	}

	private isPrintable(data: string): boolean {
		// Control bytes mean a parsed key sequence; anything else is typed text.
		return data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data);
	}

	/** Save the live input text into the current question's answer. */
	private persistInput(): void {
		const question = this.currentQuestion();
		if (!question) return;
		const text = this.input.getValue().trim();
		if (text) this.custom.set(question.id, text);
		else this.custom.delete(question.id);
	}

	/** Load the current question's typed answer into the input field. */
	private loadInput(): void {
		const question = this.currentQuestion();
		this.input.setValue(question ? this.custom.get(question.id) ?? "" : "");
	}

	private isNextTab(data: string): boolean {
		return matchesKey(data, Key.tab) || matchesKey(data, Key.right);
	}

	private isPrevTab(data: string): boolean {
		return matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
	}

	private moveTab(delta: number): void {
		this.persistInput();
		const total = this.questions.length + 1;
		this.currentTab = (this.currentTab + delta + total) % total;
		this.optionIndex = 0;
		this.loadInput();
		this.refresh();
	}

	private moveCursor(delta: number, count: number): void {
		this.optionIndex = Math.max(0, Math.min(count - 1, this.optionIndex + delta));
		this.refresh();
	}

	private activate(option: RenderOption, question: NormalizedQuestion): void {
		if (option.kind === "skip") {
			this.skip(question);
			return;
		}
		const set = this.selectionSet(question.id);
		if (question.multiSelect) {
			if (set.has(option.value)) set.delete(option.value);
			else set.add(option.value);
			this.skipped.delete(question.id);
			this.refresh();
			return;
		}
		set.clear();
		set.add(option.value);
		this.custom.delete(question.id);
		this.input.setValue("");
		this.skipped.delete(question.id);
		this.advance();
	}

	private skip(question: NormalizedQuestion): void {
		this.skipped.add(question.id);
		this.selected.get(question.id)?.clear();
		this.custom.delete(question.id);
		this.input.setValue("");
		this.advance();
	}

	private advance(): void {
		this.persistInput();
		if (this.questions.length === 1) {
			this.submit();
			return;
		}
		if (this.currentTab < this.questions.length - 1) {
			this.currentTab += 1;
			this.optionIndex = 0;
		} else {
			this.currentTab = this.questions.length;
		}
		this.loadInput();
		this.refresh();
	}

	private openNote(): void {
		const question = this.currentQuestion();
		if (!question) return;
		this.mode = "note";
		this.editor.setText(this.notes.get(question.id) ?? "");
		this.refresh();
	}

	private submitNote(value: string): void {
		const question = this.currentQuestion();
		if (!question) return;
		const text = value.trim();
		if (text) this.notes.set(question.id, text);
		else this.notes.delete(question.id);
		this.editor.setText("");
		this.mode = "nav";
		this.refresh();
	}

	/** Jump the cursor to the Type something row. Returns false when there is none. */
	private focusOther(): boolean {
		const question = this.currentQuestion();
		if (!question) return false;
		const otherIndex = optionsFor(question).findIndex((option) => option.kind === "other");
		if (otherIndex < 0) return false;
		this.optionIndex = otherIndex;
		this.refresh();
		return true;
	}

	/** Jump the cursor to the Type something row and type the first character. */
	private focusOtherAndType(data: string): void {
		if (!this.focusOther()) return;
		this.input.handleInput(data);
		this.persistInput();
		this.refresh();
	}

	private submit(): void {
		this.persistInput();
		this.done({ questions: this.questions, answers: this.buildAnswers(), interrupted: false });
	}

	private interrupt(): void {
		this.persistInput();
		this.done({ questions: this.questions, answers: this.buildAnswers(), interrupted: true });
	}

	private buildAnswers(): AnswerRecord[] {
		return this.questions.map((question) => {
			const record: AnswerRecord = {
				id: question.id,
				selections: Array.from(this.selectionSet(question.id)),
				skipped: this.skipped.has(question.id),
			};
			const custom = this.custom.get(question.id);
			if (custom) record.custom = custom;
			const note = this.notes.get(question.id);
			if (note) record.note = note;
			return record;
		});
	}

	private isAnswered(id: string): boolean {
		if (this.skipped.has(id)) return false;
		const set = this.selected.get(id);
		return (set !== undefined && set.size > 0) || Boolean(this.custom.get(id));
	}

	private pushWrapped(target: string[], prefix: string, text: string, width: number): void {
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth >= width) {
			target.push(...wrapTextWithAnsi(prefix + text, width));
			return;
		}
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
		const continuation = " ".repeat(prefixWidth);
		for (let i = 0; i < wrapped.length; i++) {
			target.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
		}
	}

	private renderQuestion(width: number): string[] {
		const question = this.currentQuestion();
		if (!question) return [];
		const theme = this.theme;
		const options = optionsFor(question);
		const cursor = options[this.optionIndex];
		this.input.focused = cursor?.kind === "other";
		const previewOption = cursor?.kind === "option" ? cursor : undefined;
		const showPreview = questionHasPreview(question);
		const layout = chooseLayout(width, showPreview);

		const head: string[] = [];
		this.pushWrapped(head, " ", theme.bold(theme.fg("text", question.prompt)), width);
		head.push("");

		const left: string[] = [];
		this.renderOptions(left, question, options, layout.optionWidth);

		let body: string[];
		if (layout.sideBySide) {
			const preview = renderPreviewBox(
				previewOption?.preview,
				previewOption?.previewLanguage,
				previewOption?.label ?? "",
				layout.previewWidth,
				theme
			);
			body = composeColumns(left, preview, layout.optionWidth, layout.gap);
		} else {
			body = left;
			if (showPreview) {
				body.push("");
				body.push(
					...renderPreviewBox(
						previewOption?.preview,
						previewOption?.previewLanguage,
						previewOption?.label ?? "",
						width,
						theme
					)
				);
			}
		}

		return [...head, ...body, "", ...this.renderNote(question, width)];
	}

	private renderOptions(
		target: string[],
		question: NormalizedQuestion,
		options: RenderOption[],
		width: number
	): void {
		const theme = this.theme;
		const set = this.selected.get(question.id);
		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			if (!option) continue;
			const active = i === this.optionIndex;
			const prefix = active ? theme.fg("accent", "> ") : "  ";

			if (option.kind === "other") {
				const number = theme.fg(active ? "accent" : "muted", `${option.index}. `);
				const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(number));
				// Show the placeholder as plain dim text unless this row is focused;
				// otherwise Input draws a fake cursor on it from another row.
				const line =
					!active && this.input.getValue().length === 0
						? padRight(theme.fg("dim", "Type something."), available)
						: this.input.render(available)[0] ?? "";
				target.push(`${prefix}${number}${line}`);
				continue;
			}

			let row = "";
			if (option.kind !== "skip") {
				row += theme.fg(active ? "accent" : "muted", `${option.index}. `);
			}
			if (question.multiSelect && option.kind === "option") {
				const checked = set?.has(option.value) ?? false;
				row += checked ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				row += " ";
			}
			row += theme.fg(active ? "accent" : option.kind === "skip" ? "muted" : "text", option.label);
			if (option.recommended) row += theme.fg("success", " (Recommended)");

			this.pushWrapped(target, prefix, row, width);
			if (option.description) {
				this.pushWrapped(target, "     ", theme.fg("muted", option.description), width);
			}
		}
	}

	private renderInlineEditor(label: string, width: number): string[] {
		const lines: string[] = [];
		this.pushWrapped(lines, " ", this.theme.fg("muted", label), width);
		for (const line of this.editor.render(Math.max(1, width - 2))) {
			lines.push(` ${line}`);
		}
		return lines;
	}

	private renderNote(question: NormalizedQuestion, width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		if (this.mode === "note") {
			return this.renderInlineEditor("Note (Enter to save · Esc to cancel):", width);
		}
		const note = this.notes.get(question.id);
		if (note) {
			this.pushWrapped(
				lines,
				" ",
				`${theme.fg("muted", "Notes: ")}${theme.fg("text", note)}`,
				width
			);
		} else {
			this.pushWrapped(lines, " ", theme.fg("dim", "Notes: ctrl+n to add a note"), width);
		}
		return lines;
	}

	private renderTabs(width: number): string[] {
		const theme = this.theme;
		const parts: string[] = [theme.fg("dim", "← ")];
		this.questions.forEach((question, index) => {
			const active = index === this.currentTab;
			const answered = this.isAnswered(question.id);
			const box = this.skipped.has(question.id) ? "–" : answered ? "■" : "□";
			const text = ` ${box} ${question.label} `;
			const color = answered ? "success" : "muted";
			const styled = active
				? theme.bg("selectedBg", theme.fg("text", text))
				: theme.fg(color, text);
			parts.push(styled, " ");
		});
		const submitActive = this.currentTab === this.questions.length;
		const submitText = " ✓ Submit ";
		const submitStyled = submitActive
			? theme.bg("selectedBg", theme.fg("text", submitText))
			: theme.fg("success", submitText);
		parts.push(submitStyled, theme.fg("dim", " →"));

		const lines: string[] = [];
		this.pushWrapped(lines, " ", parts.join(""), width);
		return lines;
	}

	private renderSubmit(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		this.pushWrapped(lines, " ", theme.bold(theme.fg("accent", "Review your answers")), width);
		lines.push("");
		for (const question of this.questions) {
			const answer = this.buildAnswerFor(question);
			this.pushWrapped(
				lines,
				" ",
				`${theme.fg("success", "✓ ")}${theme.fg("muted", `${question.label}: `)}${theme.fg(
					"text",
					answer
				)}`,
				width
			);
			const note = this.notes.get(question.id);
			if (note) this.pushWrapped(lines, "   ", theme.fg("muted", `note: ${note}`), width);
		}
		lines.push("");
		this.pushWrapped(
			lines,
			" ",
			theme.fg("dim", "Enter to submit · unanswered questions stay skipped"),
			width
		);
		return lines;
	}

	private buildAnswerFor(question: NormalizedQuestion): string {
		return answerText(question, {
			id: question.id,
			selections: Array.from(this.selected.get(question.id) ?? []),
			skipped: this.skipped.has(question.id),
			...(this.custom.get(question.id) ? { custom: this.custom.get(question.id) } : {}),
		});
	}

	private renderHelp(width: number): string[] {
		const theme = this.theme;
		const multi = this.questions.length > 1;
		const question = this.currentQuestion();
		const onOther = question ? optionsFor(question)[this.optionIndex]?.kind === "other" : false;
		let hint: string;
		if (this.mode === "note") {
			hint = "Enter to save note · Esc to cancel";
		} else if (onOther) {
			hint = "Type your answer · Enter to use it · Esc cancel";
		} else if (this.currentTab === this.questions.length) {
			hint = multi ? "Tab to switch · Esc to cancel" : "Esc to cancel";
		} else {
			const switchHint = multi ? " · Tab switch" : "";
			const parts = [
				"↑↓ move",
				question?.multiSelect === true ? "Space toggle · Enter next" : "Enter select",
				"1-9 pick",
				question?.allowOther ? "type to answer" : undefined,
				"ctrl+n note",
			].filter((part): part is string => Boolean(part));
			hint = `${parts.join(" · ")}${switchHint} · Esc cancel`;
		}
		const lines: string[] = [];
		this.pushWrapped(lines, " ", theme.fg("dim", hint), width);
		return lines;
	}
}
