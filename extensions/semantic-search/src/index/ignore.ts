/**
 * Six-layer file filter, ported from lumen's `internal/merkle/ignore.go`.
 *
 *   1. built-in directory skips (node_modules, vendor, …)
 *   2. built-in file skips (lock files)
 *   3. `.gitignore` (root + nested, plus the global git ignore)
 *   4. `.pi-searchignore` (root + nested)
 *   5. `.gitattributes` linguist-generated / linguist-vendored patterns
 *   6. supported-extension filter
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import ignore from "ignore";

type IgnoreMatcher = ReturnType<typeof ignore>;

export const SKIP_FILES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"go.sum",
	"composer.lock",
	"poetry.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"Cargo.lock",
	"Package.resolved",
	"pubspec.lock",
	"mix.lock",
	"flake.lock",
	"packages.lock.json",
]);

export const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"vendor",
	"node_modules",
	"bower_components",
	".next",
	".nuxt",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".eggs",
	".bundle",
	"target",
	".gradle",
	"_build",
	"deps",
	"dist",
	".cache",
	".output",
	".build",
	".idea",
	".vscode",
	"testdata",
]);

export type SkipFunc = (relPath: string, isDir: boolean) => boolean;

function toPosix(path: string): string {
	return path.split(/[/\\]/).join("/");
}

function loadMatcher(filePath: string): IgnoreMatcher | undefined {
	if (!existsSync(filePath)) {
		return undefined;
	}
	try {
		return ignore().add(readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

/** Compile `linguist-generated` / `linguist-vendored` patterns from .gitattributes. */
export function parseLinguistExcluded(filePath: string): IgnoreMatcher | undefined {
	if (!existsSync(filePath)) {
		return undefined;
	}
	const patterns: string[] = [];
	for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const fields = line.split(/\s+/);
		const pattern = fields[0];
		if (!pattern) {
			continue;
		}
		for (const attribute of fields.slice(1)) {
			if (
				attribute === "linguist-generated" ||
				attribute === "linguist-generated=true" ||
				attribute === "linguist-vendored" ||
				attribute === "linguist-vendored=true"
			) {
				patterns.push(pattern);
				break;
			}
		}
	}
	if (patterns.length === 0) {
		return undefined;
	}
	return ignore().add(patterns);
}

function globalGitignore(): IgnoreMatcher | undefined {
	const xdg = process.env.XDG_CONFIG_HOME;
	const candidate = xdg ? join(xdg, "git", "ignore") : join(homedir(), ".config", "git", "ignore");
	return loadMatcher(candidate);
}

interface DirIgnore {
	gitignore?: IgnoreMatcher;
	projectIgnore?: IgnoreMatcher;
	gitattributes?: IgnoreMatcher;
}

/** Directory hierarchy from the root ("") to `dirRel`, inclusive. */
export function ancestorDirs(dirRel: string): string[] {
	if (dirRel === "." || dirRel === "") {
		return [""];
	}
	const parts = toPosix(dirRel).split("/").filter(Boolean);
	const result = [""];
	for (let i = 0; i < parts.length; i += 1) {
		result.push(parts.slice(0, i + 1).join("/"));
	}
	return result;
}

export class IgnoreTree {
	private readonly rootDir: string;
	private readonly extSet: Set<string>;
	private readonly extraSkipDirs: Set<string>;
	private readonly global: IgnoreMatcher | undefined;
	private readonly dirs = new Map<string, DirIgnore>();

	constructor(
		rootDir: string,
		extensions: readonly string[],
		extraSkipDirs: readonly string[] = []
	) {
		this.rootDir = resolve(rootDir);
		this.extSet = new Set(extensions);
		this.extraSkipDirs = new Set(extraSkipDirs.map((p) => toPosix(p)));
		this.global = globalGitignore();
		this.loadDir("");
	}

	private loadDir(dirRel: string): DirIgnore {
		const cached = this.dirs.get(dirRel);
		if (cached) {
			return cached;
		}
		const absDir = dirRel === "" ? this.rootDir : join(this.rootDir, dirRel);
		const entry: DirIgnore = {
			gitignore: loadMatcher(join(absDir, ".gitignore")),
			projectIgnore: loadMatcher(join(absDir, ".pi-searchignore")),
			gitattributes: parseLinguistExcluded(join(absDir, ".gitattributes")),
		};
		this.dirs.set(dirRel, entry);
		return entry;
	}

	private evaluate(
		relPath: string,
		ancestor: string,
		isDir: boolean
	): "ignore" | "unignore" | "none" {
		const entry = this.loadDir(ancestor);
		const fromAncestor =
			ancestor === "" ? relPath : toPosix(relative(ancestor, relPath));
		const matchPath = isDir ? `${fromAncestor}/` : fromAncestor;
		// `.pi-searchignore` is the tool-specific override, so it wins over the
		// project's `.gitignore` and `.gitattributes` at the same directory level.
		const project = entry.projectIgnore?.test(matchPath);
		if (project?.ignored) {
			return "ignore";
		}
		if (project?.unignored) {
			return "unignore";
		}
		const git = entry.gitignore?.test(matchPath);
		if (git?.ignored) {
			return "ignore";
		}
		if (git?.unignored) {
			return "unignore";
		}
		if (!isDir && entry.gitattributes?.ignores(fromAncestor)) {
			return "ignore";
		}
		return "none";
	}

	/**
	 * Whether any ignore layer excludes `relPath` under Git semantics: the
	 * deepest decisive match wins, so a nested `.gitignore` negation can
	 * re-include a file a parent ignore excluded. Without this, a first-match
	 * scan from the root silently dropped explicitly un-ignored files.
	 */
	private isIgnored(relPath: string, isDir: boolean): boolean {
		const ancestors = ancestorDirs(dirname(relPath));
		for (let i = ancestors.length - 1; i >= 0; i -= 1) {
			const ancestor = ancestors[i];
			if (ancestor === undefined) {
				continue;
			}
			const verdict = this.evaluate(relPath, ancestor, isDir);
			if (verdict === "unignore") {
				return false;
			}
			if (verdict === "ignore") {
				return true;
			}
		}
		return this.global?.ignores(relPath) ?? false;
	}

	readonly shouldSkip: SkipFunc = (rawRelPath, isDir) => {
		const relPath = toPosix(rawRelPath);
		const base = basename(relPath);
		if (isDir && SKIP_DIRS.has(base)) {
			return true;
		}
		if (isDir && this.extraSkipDirs.has(relPath)) {
			return true;
		}
		if (!isDir && SKIP_FILES.has(base)) {
			return true;
		}
		if (this.isIgnored(relPath, isDir)) {
			return true;
		}
		return !isDir && !this.extSet.has(extname(relPath));
	};
}

/** Build a `SkipFunc` for a project with the given supported extensions. */
export function makeSkip(
	rootDir: string,
	extensions: readonly string[],
	extraSkipDirs: readonly string[] = []
): SkipFunc {
	return new IgnoreTree(rootDir, extensions, extraSkipDirs).shouldSkip;
}

const REFUSED_ROOTS = new Set([
	"/",
	"/Users",
	"/home",
	"/tmp",
	"/private/tmp",
	"/var",
	"/private/var",
	"/etc",
	"/usr",
	"/opt",
	"/Applications",
	"/Library",
	"/System",
]);

function resolvePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Whether a directory is unsuitable as an index root: a filesystem/system
 * root, the user's home directory, or a `.pi-searchignore` catch-all.
 */
export function isRootUnindexable(dir: string): { unindexable: boolean; reason: string } {
	const clean = resolve(dir);
	const resolved = resolvePath(dir);
	if (REFUSED_ROOTS.has(clean) || REFUSED_ROOTS.has(resolved)) {
		return { unindexable: true, reason: "hardcoded system root" };
	}
	const home = homedir();
	if (home === clean || home === resolved || resolvePath(home) === clean || resolvePath(home) === resolved) {
		return { unindexable: true, reason: "user home directory" };
	}
	const matcher = loadMatcher(join(dir, ".pi-searchignore"));
	if (!matcher) {
		return { unindexable: false, reason: "" };
	}
	const probeRoot = "pi-search-root-probe-X9F2K7M3";
	const probeNested = "pi-search-root-probe-X9F2K7M3/L8B4Q1P5R6N2";
	if (matcher.ignores(probeRoot) && matcher.ignores(probeNested)) {
		return { unindexable: true, reason: ".pi-searchignore catch-all pattern" };
	}
	return { unindexable: false, reason: "" };
}
