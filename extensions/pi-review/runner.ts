/**
 * CI runner wiring: active only when `PI_REVIEW=1`.
 *
 * In that mode the extension is the harness around an unattended review: it
 * registers `submit_review`, loads the PR context once, and injects the
 * instructions and diff through `before_agent_start`. The workflow's command
 * line stays short (`pi -p "Review pull request #12"`), and the same code path
 * serves `/pi-review run` locally.
 */

import { access, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGuidance, loadReviewTarget } from "./context.ts";
import type { Exec } from "./detect.ts";
import { type ParsedDiff, parseDiff } from "./diff.ts";
import { buildReviewPrompt } from "./prompt.ts";
import type { ValidatedReview } from "./review.ts";
import { createSubmitReviewTool, postReview, upsertStickyComment } from "./submit.ts";

export const REVIEW_ENV = "PI_REVIEW";

export function isReviewRunner(env: Record<string, string | undefined> = process.env): boolean {
	return env[REVIEW_ENV] === "1";
}

export interface RunnerOptions {
	env?: Record<string, string | undefined>;
	/** Override the executor (tests). Defaults to `pi.exec`. */
	exec?: Exec;
}

interface LoadedReview {
	target: Awaited<ReturnType<typeof loadReviewTarget>>;
	guidance: Awaited<ReturnType<typeof loadGuidance>>;
	diff: ParsedDiff;
	error?: string;
}

function prNumberFromEnv(env: Record<string, string | undefined>): number | undefined {
	const raw = env.PR_NUMBER ?? env.PI_REVIEW_PR;
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function registerReviewRunner(pi: ExtensionAPI, options: RunnerOptions = {}): void {
	const env = options.env ?? process.env;
	const exec: Exec = options.exec ?? ((command, args, opts) => pi.exec(command, args, opts));
	const dryRun = env.PI_REVIEW_DRY_RUN === "1";
	const outputPath = env.PI_REVIEW_OUTPUT;
	const requestChanges = env.PI_REVIEW_REQUEST_CHANGES === "1";
	const maxCommentsRaw = Number(env.PI_REVIEW_MAX_COMMENTS);
	const maxComments = Number.isInteger(maxCommentsRaw) && maxCommentsRaw > 0 ? maxCommentsRaw : undefined;

	let cwd = process.cwd();
	let loaded: Promise<LoadedReview> | undefined;
	// `before_agent_start` runs again for a retry or recovery; the injected
	// message is already in the transcript, so only the system prompt repeats.
	let injectedContext = false;

	const load = (): Promise<LoadedReview> => {
		loaded ??= (async () => {
			try {
				const target = await loadReviewTarget({
					exec,
					cwd,
					env,
					prNumber: prNumberFromEnv(env),
					baseRef: env.PI_REVIEW_BASE_REF,
				});
				const guidance = await loadGuidance(exec, cwd, target.baseSha);
				return { target, guidance, diff: parseDiff(target.diff) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					target: {
						source: "local" as const,
						title: "Review context unavailable",
						body: "",
						baseRef: "unknown",
						diff: "",
						notes: [],
					},
					guidance: [],
					diff: parseDiff(""),
					error: message,
				};
			}
		})();
		return loaded;
	};

	const post = dryRun
		? undefined
		: async (review: ValidatedReview) => {
				const { target } = await load();
				if (!target.repo || !target.number) {
					throw new Error(
						"No pull request to post to: set PR_NUMBER and run from a github.com checkout with `gh` available."
					);
				}
				const postTarget = { repo: target.repo, number: target.number, commitId: target.headSha };
				const result = await postReview(exec, postTarget, review, { cwd });
				try {
					await upsertStickyComment(exec, postTarget, review, result.url, { cwd });
				} catch (error) {
					// The review posted; a stale status line is not worth failing the run.
					console.error(
						`pi-review: could not update the sticky summary: ${error instanceof Error ? error.message : String(error)}`
					);
				}
				return result;
			};

	pi.registerTool(
		createSubmitReviewTool({
			getDiff: async () => (await load()).diff,
			dryRun,
			requestChanges,
			maxComments,
			outputPath,
			post,
			renderMeta: async () => {
				const { target } = await load();
				return {
					repo: target.repo,
					number: target.number,
					baseRef: target.baseRef,
					headSha: target.headSha,
					model: env.PI_MODEL,
				};
			},
		})
	);

	pi.on("before_agent_start", async (event, ctx) => {
		cwd = ctx.cwd;
		if (event.messageType !== "user") return;

		const state = await load();
		const inject = !injectedContext;
		injectedContext = true;
		if (state.error) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n## Pull-request review mode (pi-review)\n\nThe review context could not be loaded: ${state.error}\nDo not attempt a code review. Call submit_review with a short summary explaining that the review could not run.`,
				...(inject
					? {
							message: {
								customType: "pi-review-context",
								content: `<pi-review-context>\nThe review context could not be loaded: ${state.error}\n</pi-review-context>`,
								display: false,
							},
						}
					: {}),
			};
		}
		const prompt = buildReviewPrompt(state.target, state.guidance);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${prompt.system}`,
			...(inject
				? {
						message: {
							customType: "pi-review-context",
							content: prompt.context,
							display: false,
						},
					}
				: {}),
		};
	});

	// A run that never called submit_review leaves no artifact. Write one so the
	// workflow can tell "failed" from "posted nothing" without parsing logs.
	pi.on("agent_settled", async () => {
		if (!outputPath) return;
		try {
			await access(outputPath);
		} catch {
			const { target } = await load();
			await writeFile(
				outputPath,
				JSON.stringify(
					{
						dryRun,
						incomplete: true,
						error: "The review agent finished without submitting a review.",
						target: {
							repo: target.repo,
							number: target.number,
							baseRef: target.baseRef,
							headSha: target.headSha,
						},
					},
					null,
					2
				),
				"utf8"
			);
		}
	});
}
