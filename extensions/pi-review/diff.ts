/**
 * Unified-diff parsing for pi-review.
 *
 * A review comment only posts when GitHub can attach it to the diff, which
 * means the file must be in the PR and the line must be an added or unchanged
 * line (`RIGHT`) or a removed or unchanged line (`LEFT`). This module turns
 * `git diff` / `gh pr diff` output into exactly that index, so `submit_review`
 * can check every inline comment before spending an API call.
 *
 * The parser is deliberately dependency-free and forgiving: it only needs hunk
 * headers and the `---` / `+++` file headers. Anything it does not recognise
 * (rename metadata, mode changes, binary stubs) is skipped instead of failing
 * the review.
 */

export type DiffSide = "LEFT" | "RIGHT";
export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
	/** Path after the change; for deleted files this is the path before it. */
	path: string;
	/** Path before the change, when it differs (renames). */
	oldPath?: string;
	status: FileStatus;
	/** Line numbers that exist on the left (base) side of the diff. */
	left: Set<number>;
	/** Line numbers that exist on the right (head) side of the diff. */
	right: Set<number>;
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface ParsedDiff {
	files: DiffFile[];
	/** Lookup by new path, then by old path for renames and deletions. */
	byPath: Map<string, DiffFile>;
	additions: number;
	deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Git wraps paths containing spaces or control characters in double quotes. */
function unquotePath(raw: string): string {
	const value = raw.trim();
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
	const inner = value.slice(1, -1);
	let out = "";
	for (let index = 0; index < inner.length; index += 1) {
		const char = inner[index]!;
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = inner[index + 1];
		if (next === undefined) break;
		index += 1;
		if (next === "n") out += "\n";
		else if (next === "t") out += "\t";
		else if (next === "r") out += "\r";
		else out += next;
	}
	return out;
}

/** Read a `--- a/path` or `+++ b/path` header. `/dev/null` means the side is absent. */
function headerPath(raw: string): string | undefined {
	const value = unquotePath(raw);
	if (value === "/dev/null") return undefined;
	return value.replace(/^[ab]\//, "");
}

function stripGitPrefix(raw: string): string {
	return unquotePath(raw).replace(/^[ab]\//, "");
}

/**
 * Parse a unified diff. `git diff` and `gh pr diff` both produce this shape.
 */
export function parseDiff(text: string): ParsedDiff {
	const files: DiffFile[] = [];
	const byPath = new Map<string, DiffFile>();
	let current: DiffFile | undefined;
	let oldPath: string | undefined;
	let newPath: string | undefined;
	let leftPath: string | undefined;
	let rightPath: string | undefined;
	let leftLine = 0;
	let rightLine = 0;
	let inHunk = false;

	const finish = (): void => {
		if (!current) return;
		const path = newPath ?? oldPath ?? leftPath ?? rightPath;
		if (!path) {
			current = undefined;
			return;
		}
		if (current.status === "deleted") {
			current.path = oldPath ?? leftPath ?? path;
		} else {
			current.path = newPath ?? rightPath ?? path;
		}
		// Rename metadata wins; otherwise note a path change seen in the headers.
		current.oldPath = current.oldPath ?? oldPath ?? (leftPath && leftPath !== current.path ? leftPath : undefined);
		if (current.oldPath === current.path) current.oldPath = undefined;
		files.push(current);
		if (current.path) byPath.set(current.path, current);
		if (current.oldPath && !byPath.has(current.oldPath)) byPath.set(current.oldPath, current);
		current = undefined;
		oldPath = undefined;
		newPath = undefined;
		leftPath = undefined;
		rightPath = undefined;
		inHunk = false;
	};

	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	for (const line of body.split("\n")) {
		if (line.startsWith("diff --git ")) {
			finish();
			current = {
				path: "",
				status: "modified",
				left: new Set<number>(),
				right: new Set<number>(),
				additions: 0,
				deletions: 0,
				binary: false,
			};
			// `diff --git a/x b/x` is only a fallback: the ---/+++ headers carry
			// the authoritative paths, and handle renames and quoted names.
			const match = /^diff --git (?:"(.+)"|(\S+)) (?:"(.+)"|(\S+))$/.exec(line);
			if (match) {
				leftPath = stripGitPrefix(match[1] ?? match[2] ?? "");
				rightPath = stripGitPrefix(match[3] ?? match[4] ?? "");
			}
			continue;
		}

		if (!current) continue;

		if (line.startsWith("new file mode")) {
			current.status = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			current.status = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			current.status = "renamed";
			// Rename metadata carries bare paths, not the a/ b/ prefixes.
			oldPath = unquotePath(line.slice("rename from ".length));
			continue;
		}
		if (line.startsWith("rename to ")) {
			current.status = "renamed";
			newPath = unquotePath(line.slice("rename to ".length));
			continue;
		}
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			current.binary = true;
			continue;
		}

		// Inside a hunk these are content: a removed line starting with `-- `
		// arrives as `--- …`, and an added line starting with `++ ` as `+++ …`.
		if (!inHunk && line.startsWith("--- ")) {
			const path = headerPath(line.slice(4));
			if (path) leftPath = path;
			continue;
		}
		if (!inHunk && line.startsWith("+++ ")) {
			const path = headerPath(line.slice(4));
			if (path) rightPath = path;
			continue;
		}

		const hunk = HUNK_HEADER.exec(line);
		if (hunk) {
			leftLine = Number(hunk[1]);
			rightLine = Number(hunk[3]);
			inHunk = true;
			continue;
		}

		if (!inHunk) continue;

		// Inside a hunk every content line is prefixed. `\` marks the missing
		// trailing newline, and a blank line is a valid empty context line.
		const marker = line[0] ?? " ";
		if (marker === "+") {
			current.right.add(rightLine);
			current.additions += 1;
			rightLine += 1;
		} else if (marker === "-") {
			current.left.add(leftLine);
			current.deletions += 1;
			leftLine += 1;
		} else if (marker === "\\") {
			continue;
		} else {
			current.left.add(leftLine);
			current.right.add(rightLine);
			leftLine += 1;
			rightLine += 1;
		}
	}

	finish();

	let additions = 0;
	let deletions = 0;
	for (const file of files) {
		additions += file.additions;
		deletions += file.deletions;
	}
	return { files, byPath, additions, deletions };
}

/** The file a comment path refers to, tolerating `./` and a leading slash. */
export function findDiffFile(diff: ParsedDiff, path: string): DiffFile | undefined {
	const direct = diff.byPath.get(path);
	if (direct) return direct;
	const cleaned = path.replace(/^\.\//, "").replace(/^\/+/, "");
	return diff.byPath.get(cleaned);
}

/** True when GitHub can attach a comment to this path/side/line. */
export function isValidPosition(
	diff: ParsedDiff,
	path: string,
	side: DiffSide,
	line: number
): boolean {
	const file = findDiffFile(diff, path);
	if (!file) return false;
	const lines = side === "LEFT" ? file.left : file.right;
	return lines.has(line);
}

/** One line per changed file, used in the prompt when the full diff is too large. */
export function summarizeDiff(diff: ParsedDiff): string {
	if (diff.files.length === 0) return "(no changed files)";
	return diff.files
		.map((file) => {
			const marker =
				file.status === "added"
					? "added"
					: file.status === "deleted"
						? "deleted"
						: file.status === "renamed"
							? `renamed from ${file.oldPath ?? "?"}`
							: "modified";
			const counts = file.binary ? "binary" : `+${file.additions} −${file.deletions}`;
			return `- ${file.path} (${marker}, ${counts})`;
		})
		.join("\n");
}
