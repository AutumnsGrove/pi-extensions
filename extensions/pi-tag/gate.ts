/**
 * The gate: who may trigger a run, and from where.
 *
 * GitHub gives no per-issue action button, so the trigger is a comment — and a
 * comment is the one thing on an issue that a stranger can write. This module is
 * where that is decided, in tested code rather than a hundred-character `if:`
 * expression.
 *
 * The bot's own comment says how to re-tag, which means it contains the mention.
 * With an App identity, events written by that App *do* trigger workflows, so a
 * run that posts its comment would trigger the next run. Rejecting bots here is
 * therefore load-bearing, not defensive.
 */

export interface GateEvent {
	eventName: string;
	issue?: {
		number?: number;
		isPullRequest?: boolean;
		state?: string;
		authorAssociation?: string;
		userType?: string;
		login?: string;
	};
	comment?: {
		body?: string;
		authorAssociation?: string;
		userType?: string;
		login?: string;
	};
	dispatch?: { issueNumber?: string; dryRun?: boolean };
}

export interface GatePolicy {
	mention: string;
	fixWord: string;
	/** Author associations allowed to open an issue or ask for a re-tag. */
	who: string[];
	/** The bot's own login, when the identity is an App. */
	botLogin?: string;
	/** Whether `@pi fix` exists at all. */
	removal: "never" | "on-request";
}

export interface GateResult {
	run: boolean;
	/** Short, for the step summary and the log. */
	reason: string;
	issue?: number;
	/** The text after the mention, trimmed. Empty when there was none. */
	note: string;
	/** True when the note began with the fix word, so removals are allowed. */
	fix: boolean;
	dryRun: boolean;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `@pi` as a whole token. The trailing check is `(?![-\\w])` rather than `\\b`,
 * because `\\b` matches between `i` and `-` — and then `@pi-tag` would trigger a
 * tagging run.
 */
export function mentionMatch(body: string, mention: string): { index: number; length: number } | undefined {
	const pattern = new RegExp(`(^|[\\s([])${escapeRegExp(mention)}(?![-\\w])`, "i");
	const match = pattern.exec(body);
	if (match?.index === undefined) return undefined;
	const offset = match[1]?.length ?? 0;
	return { index: match.index + offset, length: mention.length };
}

/** Everything after the mention, with the fix word removed when it leads. */
export function readRequest(body: string, policy: GatePolicy): { note: string; fix: boolean } {
	const found = mentionMatch(body, policy.mention);
	if (!found) return { note: "", fix: false };
	const rest = body.slice(found.index + found.length).trim();
	if (policy.removal === "never") return { note: rest, fix: false };

	const fixPattern = new RegExp(`^${escapeRegExp(policy.fixWord)}(?![\\w-])\\s*`, "i");
	if (!fixPattern.test(rest)) return { note: rest, fix: false };
	return { note: rest.replace(fixPattern, "").trim(), fix: true };
}

function isBot(login: string | undefined, type: string | undefined, botLogin: string | undefined): boolean {
	if (type === "Bot") return true;
	if (!login) return false;
	if (botLogin && login === botLogin) return true;
	return login.endsWith("[bot]");
}

export function gate(event: GateEvent, policy: GatePolicy): GateResult {
	const refuse = (reason: string): GateResult => ({ run: false, reason, note: "", fix: false, dryRun: false });

	if (event.eventName === "workflow_dispatch") {
		const raw = event.dispatch?.issueNumber?.trim() ?? "";
		const number = Number(raw);
		if (!raw || !Number.isInteger(number) || number <= 0) {
			return refuse("workflow_dispatch needs an issue number");
		}
		return {
			run: true,
			reason: "manual run",
			issue: number,
			note: "",
			fix: false,
			dryRun: event.dispatch?.dryRun !== false,
		};
	}

	if (event.eventName === "issues") {
		const issue = event.issue;
		if (!issue) return refuse("no issue in the event");
		if (issue.isPullRequest) return refuse("pull requests are reviewed, not tagged");
		if (issue.state && issue.state.toUpperCase() !== "OPEN") return refuse("the issue is closed");
		if (!policy.who.includes(issue.authorAssociation ?? "")) {
			return refuse(`${issue.authorAssociation ?? "unknown"} may not open an issue that gets auto-tagged`);
		}
		return {
			run: true,
			reason: "issue opened",
			issue: issue.number,
			note: "",
			fix: false,
			dryRun: false,
		};
	}

	if (event.eventName === "issue_comment") {
		const issue = event.issue;
		const comment = event.comment;
		if (!issue || !comment) return refuse("no issue or comment in the event");
		if (issue.isPullRequest) return refuse("pull requests are reviewed, not tagged");
		if (issue.state && issue.state.toUpperCase() !== "OPEN") return refuse("the issue is closed");
		if (isBot(comment.login, comment.userType, policy.botLogin)) {
			return refuse("a bot may not trigger a run");
		}
		if (!policy.who.includes(comment.authorAssociation ?? "")) {
			return refuse(`${comment.authorAssociation ?? "unknown"} may not ask for a re-tag`);
		}
		if (!mentionMatch(comment.body ?? "", policy.mention)) {
			return refuse(`no ${policy.mention} in the comment`);
		}
		const request = readRequest(comment.body ?? "", policy);
		return {
			run: true,
			reason: request.fix ? "fix requested" : "re-tag requested",
			issue: issue.number,
			note: request.note,
			fix: request.fix,
			dryRun: false,
		};
	}

	return refuse(`unsupported event ${event.eventName}`);
}
