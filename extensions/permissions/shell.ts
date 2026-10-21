/**
 * Shell segmentation for permission rules.
 *
 * This is not a full shell parser — it is a fail-closed splitter. It splits a
 * command on top-level `&&`, `||`, `;`, `|`, and newlines, respecting quotes,
 * and flags constructs that cannot be judged from the text (`$(...)`,
 * backticks, process substitution, heredocs, `eval`, `bash -c`). Flagged
 * commands are never auto-allowed; rules may still deny them.
 *
 * A segment that redirects output is marked `writes`, so a read-only allow
 * rule such as `Bash(cat *)` cannot approve `cat secrets > /tmp/leak`.
 */

export interface ShellSegment {
	text: string;
	/** The segment redirects output (or otherwise writes). */
	writes: boolean;
}

export interface SplitResult {
	segments: ShellSegment[];
	opaque: boolean;
	opaqueReason?: string;
	writes: boolean;
}

const MUTATING_COMMANDS = new Set([
	"cp",
	"mv",
	"rm",
	"rmdir",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"truncate",
	"tee",
	"dd",
	"install",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

export function splitShell(command: string): SplitResult {
	const segments: ShellSegment[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	let opaque = false;
	let opaqueReason: string | undefined;
	let currentWrites = false;

	const push = (): void => {
		const text = normalizeSegment(current);
		if (text.length > 0) {
			segments.push({
				text,
				writes: currentWrites || segmentWrites(text),
			});
		}
		current = "";
		currentWrites = false;
	};

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;
		const next = command[i + 1];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (quote === "'") {
			current += char;
			if (char === "'") quote = null;
			continue;
		}

		if (quote === '"') {
			if (char === "\\") {
				escaped = true;
				current += char;
				continue;
			}
			if (char === '"') quote = null;
			if (char === "$" && next === "(") {
				opaque = true;
				opaqueReason ??= "command substitution";
			}
			current += char;
			continue;
		}

		if (quote === "`") {
			current += char;
			if (char === "`") quote = null;
			continue;
		}

		// Top level.
		if (char === "\\") {
			escaped = true;
			current += char;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			if (char === "`") {
				opaque = true;
				opaqueReason ??= "backtick substitution";
			}
			continue;
		}
		if (char === "$" && next === "(") {
			opaque = true;
			opaqueReason ??= "command substitution";
			current += char;
			continue;
		}
		if ((char === "<" || char === ">") && next === "(") {
			opaque = true;
			opaqueReason ??= "process substitution";
			current += char;
			continue;
		}
		if (char === "<" && next === "<") {
			opaque = true;
			opaqueReason ??= "heredoc";
			current += char;
			continue;
		}
		if (char === "#" && (i === 0 || /\s/.test(command[i - 1] ?? ""))) {
			// Comment: drop the rest of the line.
			const newline = command.indexOf("\n", i);
			if (newline === -1) break;
			i = newline;
			push();
			continue;
		}
		if (char === "&" && next === "&") {
			push();
			i += 1;
			continue;
		}
		if (char === "|" && next === "|") {
			push();
			i += 1;
			continue;
		}
		if (char === ";" || char === "\n" || char === "|") {
			push();
			continue;
		}
		if (char === ">") {
			currentWrites = true;
		}
		current += char;
	}

	push();

	if (opaque) {
		// An opaque command cannot be judged segment-by-segment.
		return {
			segments,
			opaque: true,
			opaqueReason,
			writes: segments.some((segment) => segment.writes),
		};
	}

	return {
		segments,
		opaque: false,
		writes: segments.some((segment) => segment.writes),
	};
}

/** Collapse whitespace and drop leading `VAR=value` assignments. */
export function normalizeSegment(segment: string): string {
	let text = segment.trim().replace(/\s+/g, " ");
	// `FOO=bar BAZ=qux cmd ...` → `cmd ...`
	const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
	while (assignment.test(text)) {
		text = text.replace(assignment, "");
	}
	return text;
}

/** Commands that mutate even without a redirect. */
export function segmentWrites(segment: string): boolean {
	const text = normalizeSegment(segment);
	const first = text.split(" ", 1)[0] ?? "";
	const base = first.split("/").pop() ?? first;
	if (MUTATING_COMMANDS.has(base)) return true;
	if (base === "sed" && /\s-[A-Za-z]*i/.test(text)) return true;
	if (base === "perl" && /\s-[A-Za-z]*i/.test(text)) return true;
	if (base === "find" && /\s-(delete|exec|execdir|ok)\b/.test(text)) return true;
	if (base === "xargs" && /\b(rm|mv|cp|sed|tee|sh|bash)\b/.test(text)) return true;
	return false;
}

/** True when the segment invokes a shell with `-c` or `eval`. */
export function isOpaqueWrapper(segment: string): boolean {
	const text = normalizeSegment(segment);
	const first = text.split(" ", 1)[0] ?? "";
	const base = first.split("/").pop() ?? first;
	if (base === "eval") return true;
	if (SHELLS.has(base) && /\s-c\b/.test(text)) return true;
	if ((base === "source" || base === ".") && text.length > base.length) return true;
	return false;
}

/**
 * Extract the command an opaque wrapper would run, when it can be read
 * statically: `bash -c 'rm -rf /'` and `eval rm -rf /`. Returns `undefined`
 * for `bash script.sh` and `source file`, which cannot be judged without
 * reading or running the target.
 */
export function unwrapSegment(segment: string): string | undefined {
	const text = normalizeSegment(segment);
	const first = text.split(" ", 1)[0] ?? "";
	const base = first.split("/").pop() ?? first;

	if (base === "eval") {
		return stripQuotes(text.slice("eval".length).trim());
	}
	if (SHELLS.has(base)) {
		const match = text.match(/\s-c\s+([\s\S]+)$/);
		if (match) return stripQuotes(match[1]!.trim());
	}
	return undefined;
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
			return value.slice(1, -1);
		}
	}
	return value;
}
