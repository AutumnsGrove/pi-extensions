/**
 * Where memories live.
 *
 * Pi's own store is `$PI_CODING_AGENT_DIR/memory/<project-slug>/`, which is
 * `~/.pi/agent/memory/...` by default. The slug is the one pi already uses for
 * session directories, so a project's memories and its sessions sort together.
 *
 * Nothing here ever points inside the repository: memories are not committed,
 * not shared by checkout, and cannot accidentally be edited into the tree.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

/** pi's agent directory, honouring `PI_CODING_AGENT_DIR`. */
export function agentDir(env: Env = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (override && override.length > 0) {
		return expandHome(override);
	}
	return join(homedir(), ".pi", "agent");
}

/** The root that holds one directory per project. */
export function memoryRoot(env: Env = process.env): string {
	const override = env.PI_MEMORY_DIR;
	if (override && override.length > 0) {
		return expandHome(override);
	}
	return join(agentDir(env), "memory");
}

/** Path to the pi-memory config file. */
export function configFile(env: Env = process.env): string {
	const override = env.PI_MEMORY_CONFIG;
	if (override && override.length > 0) {
		return expandHome(override);
	}
	return join(agentDir(env), "memory.json");
}

/**
 * Pi's session slug for a working directory.
 *
 * Mirrors `--Users-autumn-Documents-Projects-pi-extensions--`: strip the
 * leading separator, turn every separator or colon into `-`, and wrap in `--`.
 * Session grouping and memory grouping therefore agree.
 */
export function slugForPath(path: string): string {
	const stripped = path.replace(/^[/\\]/, "");
	return `--${stripped.replace(/[/\\:]/g, "-")}--`;
}

/**
 * Claude Code's project slug.
 *
 * Claude uses the same mechanical transform but without the wrapping dashes:
 * `/Users/autumn/Documents/Projects/x` → `-Users-autumn-Documents-Projects-x`.
 */
export function claudeSlugForPath(path: string): string {
	return path.replace(/[/\\:]/g, "-");
}

/** Git toplevel for a directory, or undefined outside a repository. */
export function gitRootFor(cwd: string): string | undefined {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
		return out.length > 0 ? resolve(out) : undefined;
	} catch {
		return undefined;
	}
}

/** The directory whose slug names the store, after applying `memory.scope`. */
export function scopePath(cwd: string, scope: "cwd" | "git-root"): string {
	const resolved = resolve(cwd);
	if (scope === "git-root") {
		return gitRootFor(resolved) ?? resolved;
	}
	return resolved;
}

export interface StorePathOptions {
	cwd: string;
	scope: "cwd" | "git-root";
	store: "pi" | "claude";
	env?: Env;
	/** Used to derive the claude projects directory in tests. */
	claudeProjectsDir?: string;
}

/** Directory holding this project's memory files. */
export function storeDirFor(options: StorePathOptions): string {
	const env = options.env ?? process.env;
	const override = env.PI_MEMORY_DIR;
	if (override && override.length > 0) {
		return expandHome(override);
	}
	const base = scopePath(options.cwd, options.scope);
	if (options.store === "claude") {
		return claudeStoreDir(base, {
			env,
			projectsDir: options.claudeProjectsDir,
		});
	}
	return join(memoryRoot(env), slugForPath(base));
}

export interface ClaudeStoreOptions {
	env?: Env;
	projectsDir?: string;
}

/** Claude Code's project store for a directory, whether or not it exists. */
export function claudeStoreDir(path: string, options: ClaudeStoreOptions = {}): string {
	const env = options.env ?? process.env;
	const projectsDir =
		options.projectsDir ??
		(env.CLAUDE_CONFIG_DIR
			? join(expandHome(env.CLAUDE_CONFIG_DIR), "projects")
			: join(env.HOME ? expandHome(env.HOME) : homedir(), ".claude", "projects"));
	return join(projectsDir, claudeSlugForPath(resolve(path)), "memory");
}

/** Claude's store for the same project, used by `/memory import`. */
export function claudeSourceDirFor(cwd: string, options: ClaudeStoreOptions = {}): string {
	return claudeStoreDir(scopePath(cwd, "cwd"), options);
}

/**
 * Display form: `~/…` for paths under home, so status output stays short.
 * Purely cosmetic; callers keep the absolute path for filesystem access.
 */
export function displayPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}
