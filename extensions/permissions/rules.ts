/**
 * Rule evaluation.
 *
 * Rules use Claude's permission-rule syntax (`Bash(git *)`, `Edit(*.ts)`).
 * Bash commands are split into segments and every segment must be allowed, so
 * `git status && rm -rf /` cannot be approved by `Bash(git status)`.
 *
 * Defaults are conservative and additive. They can be disabled with
 * `"useDefaultRules": false`, but deny rules from the config always win.
 */

import {
	matchesPermissionRule,
	parsePermissionRule,
	ruleSubject,
} from "../hooks/events.ts";
import {
	isOpaqueWrapper,
	normalizeSegment,
	segmentWrites,
	splitShell,
	unwrapSegment,
	type ShellSegment,
} from "./shell.ts";
import type { Decision, RuleEntry, RuleVerdict } from "./types.ts";

export const DEFAULT_ALLOW: readonly string[] = [
	// pi's read-only tools
	"Read(*)",
	"Grep(*)",
	"Find(*)",
	"Ls(*)",
	"WebSearch(*)",
	"WebFetch(*)",
	// shell reads
	"Bash(cat *)",
	"Bash(head *)",
	"Bash(tail *)",
	"Bash(less *)",
	"Bash(wc *)",
	"Bash(file *)",
	"Bash(stat *)",
	"Bash(ls *)",
	"Bash(tree *)",
	"Bash(pwd)",
	"Bash(which *)",
	"Bash(whoami)",
	"Bash(date *)",
	"Bash(uname *)",
	"Bash(df *)",
	"Bash(du *)",
	"Bash(ps *)",
	"Bash(env)",
	"Bash(printenv *)",
	"Bash(grep *)",
	"Bash(rg *)",
	"Bash(jq *)",
	"Bash(diff *)",
	"Bash(sort *)",
	"Bash(uniq *)",
	"Bash(cut *)",
	"Bash(column *)",
	// git reads
	"Bash(git status)",
	"Bash(git status *)",
	"Bash(git log *)",
	"Bash(git diff)",
	"Bash(git diff *)",
	"Bash(git show *)",
	"Bash(git blame *)",
	"Bash(git reflog *)",
	"Bash(git remote *)",
	"Bash(git tag)",
	"Bash(git tag -l *)",
	"Bash(git branch)",
	"Bash(git branch -a)",
	"Bash(git branch -v)",
	"Bash(git branch --list *)",
	"Bash(git stash list)",
	"Bash(git describe *)",
	"Bash(git rev-parse *)",
	// package and tool introspection
	"Bash(npm list *)",
	"Bash(npm info *)",
	"Bash(npm view *)",
	"Bash(npm outdated *)",
	"Bash(npm audit *)",
	"Bash(pnpm list *)",
	"Bash(pnpm why *)",
	"Bash(yarn list *)",
	"Bash(pip list *)",
	"Bash(pip show *)",
	"Bash(pip freeze *)",
	"Bash(cargo tree *)",
	"Bash(cargo metadata *)",
	"Bash(go list *)",
	"Bash(go env *)",
	"Bash(go version)",
	"Bash(docker ps *)",
	"Bash(docker images *)",
	"Bash(docker logs *)",
	"Bash(docker inspect *)",
	"Bash(docker version)",
	"Bash(docker info)",
	"Bash(node --version)",
	"Bash(npm --version)",
	"Bash(python --version)",
	"Bash(uv --version)",
];

export const DEFAULT_ASK: readonly string[] = [
	"Bash(git push *)",
	"Bash(git reset --hard)",
	"Bash(git reset --hard *)",
	"Bash(git clean *)",
	"Bash(git checkout -- *)",
	"Bash(npm publish)",
	"Bash(npm publish *)",
	"Bash(pnpm publish)",
	"Bash(pnpm publish *)",
	"Bash(yarn publish)",
	"Bash(yarn publish *)",
	"Bash(cargo publish)",
	"Bash(cargo publish *)",
	"Bash(docker run *)",
	"Bash(docker compose up *)",
	"Bash(kubectl apply *)",
	"Bash(kubectl delete *)",
	"Bash(terraform apply *)",
	"Bash(terraform destroy *)",
	"Bash(curl *)",
	"Bash(wget *)",
	"Bash(ssh *)",
	"Bash(scp *)",
	"Bash(rsync *)",
];

export const DEFAULT_DENY: readonly string[] = [
	"Bash(rm -rf /)",
	"Bash(rm -rf /*)",
	"Bash(rm -rf ~)",
	"Bash(rm -rf ~/*)",
	"Bash(rm -rf $HOME)",
	"Bash(rm -rf $HOME/*)",
	"Bash(sudo *)",
	"Bash(su *)",
	"Bash(doas *)",
	"Bash(mkfs *)",
	"Bash(mkfs*)",
	"Bash(dd if=*)",
	"Bash(shutdown *)",
	"Bash(reboot *)",
	"Bash(halt *)",
	"Bash(poweroff *)",
	"Bash(init 0)",
	"Bash(init 6)",
	"Bash(chmod -R 777 /)",
	"Bash(chmod -R 777 /*)",
	"Bash(chown -R * /)",
	"Bash(:(){ :|:& };:)",
	"Bash(curl * | sh)",
	"Bash(curl * | bash)",
	"Bash(wget * | sh)",
	"Bash(wget * | bash)",
	"Bash(> /dev/sd*)",
	"Bash(> /dev/disk*)",
];

export function defaultRules(): { allow: RuleEntry[]; ask: RuleEntry[]; deny: RuleEntry[] } {
	const entry = (rule: string): RuleEntry => ({ rule, source: "default" });
	return {
		allow: DEFAULT_ALLOW.map(entry),
		ask: DEFAULT_ASK.map(entry),
		deny: DEFAULT_DENY.map(entry),
	};
}

/** Every rule string in a list, for display and grant checks. */
export function ruleStrings(entries: RuleEntry[]): string[] {
	return entries.map((entry) => entry.rule);
}

interface Match {
	entry: RuleEntry;
	pattern?: string;
}

function matchesEntry(entry: RuleEntry, tool: string, input: Record<string, unknown>): Match | undefined {
	const parsed = parsePermissionRule(entry.rule);
	if (!parsed) return undefined;
	if (!matchesPermissionRule(parsed, tool, input)) return undefined;
	return { entry, pattern: parsed.pattern };
}

function firstMatch(
	entries: RuleEntry[],
	tool: string,
	input: Record<string, unknown>,
): Match | undefined {
	// Later rules win, so project entries override defaults when both match.
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const match = matchesEntry(entries[i]!, tool, input);
		if (match) return match;
	}
	return undefined;
}

function combine(matches: {
	deny: Match[];
	ask: Match[];
	allow: Match[];
	segments: number;
	allowedSegments: number;
}): RuleVerdict {
	if (matches.deny.length > 0) {
		return {
			decision: "deny",
			matched: matches.deny.map((match) => match.entry.rule),
			reasons: ["a deny rule matched"],
		};
	}
	if (matches.ask.length > 0) {
		return {
			decision: "ask",
			matched: matches.ask.map((match) => match.entry.rule),
			reasons: ["an ask rule matched"],
		};
	}
	if (matches.segments > 0 && matches.allowedSegments === matches.segments) {
		return {
			decision: "allow",
			matched: matches.allow.map((match) => match.entry.rule),
			reasons: ["every segment matched an allow rule"],
		};
	}
	return { decision: "none", matched: [], reasons: [] };
}

/** Evaluate one tool call against the three rule lists. */
export function evaluateRules(
	tool: string,
	input: Record<string, unknown>,
	rules: { allow: RuleEntry[]; ask: RuleEntry[]; deny: RuleEntry[] },
	depth = 0,
): RuleVerdict {
	if (tool === "bash" || tool === "powershell") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command.trim()) {
			return { decision: "none", matched: [], reasons: [] };
		}

		const split = splitShell(command);
		const opaque = split.opaque || split.segments.some((segment) => isOpaqueWrapper(segment.text));

		// A deny rule may match the whole command even when it is opaque.
		const wholeInput = { ...input, command };
		const wholeDeny = firstMatch(rules.deny, tool, wholeInput);
		if (wholeDeny) {
			return {
				decision: "deny",
				matched: [wholeDeny.entry.rule],
				reasons: ["a deny rule matched"],
			};
		}

		if (opaque || split.segments.length === 0) {
			const wrappers = split.segments
				.map((segment) => unwrapSegment(segment.text))
				.filter((command): command is string => command !== undefined && command.length > 0);

			// `bash -c 'rm -rf /'` can be judged by judging the inner command.
			if (depth < 3 && wrappers.length > 0) {
				const inner = wrappers.map((command) =>
					evaluateRules(tool, { ...input, command }, rules, depth + 1),
				);
				const combined = worstDecision(...inner.map((verdict) => verdict.decision));
				if (combined === "deny") {
					return {
						decision: "deny",
						matched: inner.flatMap((verdict) => verdict.matched),
						reasons: ["an opaque wrapper contains a denied command"],
					};
				}
				if (combined === "allow" && !split.opaque) {
					return {
						decision: "allow",
						matched: inner.flatMap((verdict) => verdict.matched),
						reasons: ["the wrapped command is allowed"],
					};
				}
			}

			// Fail closed: cannot justify an allow for text we cannot parse.
			const wholeAsk = firstMatch(rules.ask, tool, wholeInput);
			return {
				decision: "ask",
				matched: wholeAsk ? [wholeAsk.entry.rule] : [],
				reasons: [
					split.opaqueReason
						? `opaque shell construct: ${split.opaqueReason}`
						: "opaque shell construct",
				],
			};
		}

		const collected = {
			deny: [] as Match[],
			ask: [] as Match[],
			allow: [] as Match[],
			segments: split.segments.length,
			allowedSegments: 0,
		};

		for (const segment of split.segments) {
			const segmentInput = { ...input, command: segment.text };
			const deny = firstMatch(rules.deny, tool, segmentInput);
			if (deny) {
				collected.deny.push(deny);
				continue;
			}
			const ask = firstMatch(rules.ask, tool, segmentInput);
			if (ask) {
				collected.ask.push(ask);
				continue;
			}
			const allow = firstMatch(rules.allow, tool, segmentInput);
			if (allow && canAllowSegment(segment, allow)) {
				collected.allow.push(allow);
				collected.allowedSegments += 1;
			}
		}

		return combine(collected);
	}

	const deny = firstMatch(rules.deny, tool, input);
	if (deny) {
		return {
			decision: "deny",
			matched: [deny.entry.rule],
			reasons: ["a deny rule matched"],
		};
	}
	const ask = firstMatch(rules.ask, tool, input);
	if (ask) {
		return {
			decision: "ask",
			matched: [ask.entry.rule],
			reasons: ["an ask rule matched"],
		};
	}
	const allow = firstMatch(rules.allow, tool, input);
	if (allow) {
		return {
			decision: "allow",
			matched: [allow.entry.rule],
			reasons: ["an allow rule matched"],
		};
	}
	return { decision: "none", matched: [], reasons: [] };
}

/**
 * A read-only allow rule must not approve a segment that redirects output or
 * calls a mutating command, unless the rule itself mentions the redirect.
 */
function canAllowSegment(segment: ShellSegment, match: Match): boolean {
	if (!segment.writes && !segmentWrites(segment.text)) return true;
	return match.pattern !== undefined && /[>|]/.test(match.pattern);
}

/** A rule that would reproduce an "always allow" choice for this call. */
export function ruleForCall(tool: string, input: Record<string, unknown>): string | undefined {
	if (tool.startsWith("mcp__")) return tool;
	if (tool === "bash" || tool === "powershell") {
		const command = typeof input.command === "string" ? input.command : "";
		const normalized = normalizeSegment(command);
		if (!normalized || /[()]/.test(normalized)) return undefined;
		return `Bash(${normalized})`;
	}
	const subject = ruleSubject(tool, input);
	const canonical =
		tool === "write"
			? "Write"
			: tool === "edit"
				? "Edit"
				: tool === "read"
					? "Read"
					: tool.charAt(0).toUpperCase() + tool.slice(1);
	if (!subject) return canonical;
	if (/[()]/.test(subject)) return undefined;
	return `${canonical}(${subject})`;
}

/** Stable key for session grants and the verdict cache. */
export function callKey(tool: string, input: Record<string, unknown>, cwd: string): string {
	const subject =
		tool === "bash" || tool === "powershell"
			? normalizeSegment(typeof input.command === "string" ? input.command : "")
			: `${ruleSubject(tool, input)}|${stableStringify(input)}`;
	return `${tool}\u0000${subject}\u0000${cwd}`;
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(",")}}`;
}

/** Combine rule verdicts the way a deny-first policy would. */
export function worstDecision(...decisions: (Decision | "none")[]): Decision | "none" {
	if (decisions.includes("deny")) return "deny";
	if (decisions.includes("ask")) return "ask";
	if (decisions.includes("allow")) return "allow";
	return "none";
}
