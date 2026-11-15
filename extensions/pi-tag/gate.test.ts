import { describe, expect, it } from "vitest";
import { gate, mentionMatch, readRequest, type GatePolicy } from "./gate.ts";
import { DEFAULT_SETTINGS, SettingsError, parseSettings } from "./settings.ts";

const policy: GatePolicy = {
	mention: "@pi",
	fixWord: "fix",
	who: ["OWNER", "MEMBER", "COLLABORATOR"],
	botLogin: "pi-tag-autumnsgrove[bot]",
	removal: "on-request",
};

const openIssue = { number: 42, isPullRequest: false, state: "OPEN" };

describe("mentionMatch", () => {
	it("finds the mention at the start or after whitespace", () => {
		expect(mentionMatch("@pi", "@pi")).toBeDefined();
		expect(mentionMatch("please @pi re-tag", "@pi")).toBeDefined();
		expect(mentionMatch("(@pi)", "@pi")).toBeDefined();
	});

	it("does not match a longer token", () => {
		expect(mentionMatch("@pi-tag please", "@pi")).toBeUndefined();
		expect(mentionMatch("@pineapple", "@pi")).toBeUndefined();
		expect(mentionMatch("email@pi.com", "@pi")).toBeUndefined();
	});
});

describe("readRequest", () => {
	it("reads the note that follows the mention", () => {
		expect(readRequest("@pi the files are under libs", policy)).toEqual({
			note: "the files are under libs",
			fix: false,
		});
	});

	it("strips the fix word and turns removals on", () => {
		expect(readRequest("@pi fix the fonts live in landing", policy)).toEqual({
			note: "the fonts live in landing",
			fix: true,
		});
		expect(readRequest("@pi FIX", policy)).toEqual({ note: "", fix: true });
	});

	it("is not fooled by a word that starts with fix", () => {
		expect(readRequest("@pi fixed the bug", policy)).toEqual({ note: "fixed the bug", fix: false });
	});

	it("ignores fix when removal is off", () => {
		expect(readRequest("@pi fix something", { ...policy, removal: "never" })).toEqual({ note: "fix something", fix: false });
	});
});

describe("gate", () => {
	it("runs when you open an issue", () => {
		const result = gate({ eventName: "issues", issue: { ...openIssue, authorAssociation: "OWNER" } }, policy);
		expect(result).toMatchObject({ run: true, issue: 42, fix: false, dryRun: false });
	});

	it("refuses an issue from a stranger", () => {
		const result = gate({ eventName: "issues", issue: { ...openIssue, authorAssociation: "NONE" } }, policy);
		expect(result.run).toBe(false);
		expect(result.reason).toContain("may not open an issue");
	});

	it("refuses a pull request", () => {
		const result = gate(
			{ eventName: "issues", issue: { ...openIssue, isPullRequest: true, authorAssociation: "OWNER" } },
			policy
		);
		expect(result.run).toBe(false);
		expect(result.reason).toContain("reviewed, not tagged");
	});

	it("refuses a closed issue", () => {
		const result = gate(
			{ eventName: "issues", issue: { ...openIssue, state: "CLOSED", authorAssociation: "OWNER" } },
			policy
		);
		expect(result.run).toBe(false);
	});

	it("runs on a collaborator's comment", () => {
		const result = gate(
			{
				eventName: "issue_comment",
				issue: openIssue,
				comment: { body: "@pi fix `landing` is wrong", authorAssociation: "COLLABORATOR", userType: "User" },
			},
			policy
		);
		expect(result).toMatchObject({ run: true, issue: 42, fix: true, note: "`landing` is wrong" });
	});

	it("refuses its own comment, which is what stops the loop", () => {
		// The comment it posts says how to re-tag, so it contains the mention.
		const result = gate(
			{
				eventName: "issue_comment",
				issue: openIssue,
				comment: { body: "Re-tag: comment `@pi`", authorAssociation: "OWNER", userType: "Bot", login: "pi-tag-x[bot]" },
			},
			policy
		);
		expect(result.run).toBe(false);
		expect(result.reason).toContain("bot");
	});

	it("refuses a stranger's comment even when it mentions @pi", () => {
		const result = gate(
			{ eventName: "issue_comment", issue: openIssue, comment: { body: "@pi tag this", authorAssociation: "NONE" } },
			policy
		);
		expect(result.run).toBe(false);
	});

	it("refuses a comment with no mention", () => {
		const result = gate(
			{ eventName: "issue_comment", issue: openIssue, comment: { body: "thanks!", authorAssociation: "OWNER" } },
			policy
		);
		expect(result.run).toBe(false);
		expect(result.reason).toContain("no @pi");
	});

	it("ignores a mention on a pull request", () => {
		const result = gate(
			{
				eventName: "issue_comment",
				issue: { ...openIssue, isPullRequest: true },
				comment: { body: "@pi review this", authorAssociation: "OWNER" },
			},
			policy
		);
		expect(result.run).toBe(false);
	});

	it("takes a manual dispatch, dry by default", () => {
		expect(gate({ eventName: "workflow_dispatch", dispatch: { issueNumber: "42" } }, policy)).toMatchObject({
			run: true,
			issue: 42,
			dryRun: true,
		});
		expect(
			gate({ eventName: "workflow_dispatch", dispatch: { issueNumber: "42", dryRun: false } }, policy)
		).toMatchObject({ run: true, dryRun: false });
	});

	it("refuses a dispatch with no issue number", () => {
		expect(gate({ eventName: "workflow_dispatch", dispatch: {} }, policy).run).toBe(false);
		expect(gate({ eventName: "workflow_dispatch", dispatch: { issueNumber: "abc" } }, policy).run).toBe(false);
	});

	it("refuses an event it does not handle", () => {
		expect(gate({ eventName: "push" }, policy).run).toBe(false);
	});
});

describe("settings", () => {
	it("fills in the defaults the plan argues for", () => {
		const settings = parseSettings({ version: 1 });
		expect(settings).toEqual(DEFAULT_SETTINGS);
	});

	it("reads a real file's worth of settings", () => {
		const settings = parseSettings({
			version: 1,
			identity: "token",
			model: "deepseek-v4.1-flash",
			thinking: "low",
			triggers: { mention: "@grove", who: ["OWNER"] },
			labels: { remove: "never" },
			timeoutMinutes: 10,
		});
		expect(settings.identity).toBe("token");
		expect(settings.model).toBe("deepseek-v4.1-flash");
		expect(settings.thinking).toBe("low");
		expect(settings.triggers.mention).toBe("@grove");
		expect(settings.labels.remove).toBe("never");
		expect(settings.timeoutMinutes).toBe(10);
	});

	it("refuses a shell, because a tagger has nothing to execute", () => {
		expect(() => parseSettings({ version: 1, tools: { bash: true } })).toThrow(SettingsError);
		try {
			parseSettings({ version: 1, tools: { bash: true } });
		} catch (error) {
			expect((error as SettingsError).problems.join(" ")).toContain("never runs a shell");
		}
	});

	it("refuses a trigger nobody could type", () => {
		expect(() => parseSettings({ version: 1, triggers: { mention: "pi" } })).toThrow(/expected a mention/);
	});

	it("refuses an event that would run twice", () => {
		expect(() => parseSettings({ version: 1, triggers: { types: ["opened", "edited"] } })).toThrow(/only "opened"/);
	});

	it("refuses an unknown removal mode and association", () => {
		expect(() => parseSettings({ version: 1, labels: { remove: "always" } })).toThrow(/labels.remove/);
		expect(() => parseSettings({ version: 1, triggers: { who: ["EVERYONE"] } })).toThrow(/unknown association/);
	});

	it("refuses a timeout outside the range", () => {
		expect(() => parseSettings({ version: 1, timeoutMinutes: 0 })).toThrow(/between 1 and 30/);
	});

	it("reports every problem at once", () => {
		try {
			parseSettings({ version: 2, thinking: "maximum", timeoutMinutes: 99 });
		} catch (error) {
			expect((error as SettingsError).problems).toHaveLength(3);
		}
	});
});
