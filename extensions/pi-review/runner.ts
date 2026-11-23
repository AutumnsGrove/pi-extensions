/**
 * CI runner wiring: active only when `PI_REVIEW=1`.
 *
 * In that mode the extension is the harness around an unattended review: it
 * registers `submit_review`, loads the PR context once, and injects the
 * instructions and diff through `before_agent_start`. The workflow's command
 * line stays short (`pi -p "Review pull request #12"`), and the same code path
 * serves `/pi-review run` locally.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGuidance, loadReviewTarget } from "./context.ts";
import type { Exec } from "./detect.ts";
import { type ParsedDiff, parseDiff } from "./diff.ts";
import {
	assistantText,
	classifySettlement,
	isSubstantiveReview,
	recoverySummary,
} from "./failure.ts";
import { extractImages, fetchImages } from "./images.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { redactSecrets } from "./redact.ts";
import { type ValidatedReview, renderReviewMarkdown } from "./review.ts";
import { createSubmitReviewTool, postReview, upsertStickyComment } from "./submit.ts";
import {
	type ReviewThread,
	RESOLVE_REQUIRES_CONTENTS_WRITE,
	createResolveThreadsTool,
	fetchBotThreads,
	resolveThreads,
} from "./github/threads.ts";

export const REVIEW_ENV = "PI_REVIEW";

/** One explicit second turn for a model that ended the review in prose (#44). */
export const NUDGE_MESSAGE =
	"You have not called submit_review, so nothing has reached GitHub. Call submit_review now with the findings you already have. Do not answer in prose; do not re-review the code. If nothing is worth flagging, submit a short summary saying the change looks sound.";

export function isReviewRunner(env: Record<string, string | undefined> = process.env): boolean {
	return env[REVIEW_ENV] === "1";
}

export interface RunnerOptions {
	env?: Record<string, string | undefined>;
	/** Override the executor (tests). Defaults to `pi.exec`. */
	exec?: Exec;
	/** Override the screenshot download (tests). Defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

interface LoadedReview {
	target: Awaited<ReturnType<typeof loadReviewTarget>>;
	guidance: Awaited<ReturnType<typeof loadGuidance>>;
	diff: ParsedDiff;
	threads: ReviewThread[];
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
	const fetchImpl = options.fetchImpl ?? fetch;
	const dryRun = env.PI_REVIEW_DRY_RUN === "1";
	const outputPath = env.PI_REVIEW_OUTPUT;
	const requestChanges = env.PI_REVIEW_REQUEST_CHANGES === "1";
	// Resolving threads is a mutation: never do it in a dry run, even if the
	// setting is on and the caller forgot to clear the env flag.
	const resolveStaleThreads = env.PI_REVIEW_RESOLVE_THREADS === "1" && !dryRun;
	const maxCommentsRaw = Number(env.PI_REVIEW_MAX_COMMENTS);
	const maxComments = Number.isInteger(maxCommentsRaw) && maxCommentsRaw > 0 ? maxCommentsRaw : undefined;

	let cwd = process.cwd();
	let loaded: Promise<LoadedReview> | undefined;
	// `before_agent_start` runs again for a retry or recovery; the injected
	// message is already in the transcript, so only the system prompt repeats.
	let injectedContext = false;
	// The final assistant message is the only record of how the run ended. A
	// provider error and a model that finished in prose both leave no artifact,
	// and they must not be reported as the same thing (issue #27).
	let lastAssistant: AssistantMessage | undefined;
	// A nudge can produce a short "I already answered" turn after a substantive
	// review. Keep the last answer worth posting, not merely the last message.
	let lastSubstantiveText = "";
	let submitted = false;
	let submittedReview: ValidatedReview | undefined;
	// One nudge per process; the continuation itself can settle again.
	let nudged = false;

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
				let threads: ReviewThread[] = [];
				if (resolveStaleThreads && target.repo && target.number) {
					try {
						threads = await fetchBotThreads(exec, cwd, target.repo, target.number);
						// GitHub answers `viewerCanResolve` per thread, so this is a fact
						// about the token, not a guess. The threads are still listed: the
						// reviewer uses them to check whether an earlier finding holds, and
						// saying so once in the log beats nine refused mutations (#55).
						if (threads.length > 0 && !threads.some((thread) => thread.canResolve)) {
							console.warn(
								`pi-review: listing ${threads.length} open bot review thread${threads.length === 1 ? "" : "s"}, but this token cannot resolve them: ${RESOLVE_REQUIRES_CONTENTS_WRITE}.`
							);
						}
					} catch (error) {
						console.error(
							`pi-review: could not read review threads: ${error instanceof Error ? error.message : String(error)}`
						);
					}
				}
				// Positions must validate against the full PR diff: an incremental
				// diff is a tree comparison and can contain content GitHub does not
				// consider part of the PR.
				return {
					target,
					guidance,
					diff: parseDiff(target.validationDiff ?? target.diff),
					threads,
				};
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
					threads: [],
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

	if (resolveStaleThreads) {
		pi.registerTool(
			createResolveThreadsTool({
				getThreads: async () => (await load()).threads,
				resolve: (ids) => resolveThreads(exec, cwd, ids),
			})
		);
	}

	pi.registerTool(
		createSubmitReviewTool({
			getDiff: async () => (await load()).diff,
			dryRun,
			requestChanges,
			maxComments,
			outputPath,
			post,
			onSubmitted: (review) => {
				submitted = true;
				submittedReview = review;
			},
			extraDetails: () => (nudged ? { nudged: true } : {}),
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

	// `message_end` is the authoritative final message, so this survives retries,
	// compaction recovery, and the nudge below.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		lastAssistant = event.message;
		if (event.message.stopReason !== "stop") return;
		const text = assistantText(event.message);
		if (isSubstantiveReview(text)) lastSubstantiveText = text;
	});

	// A model that ends a long review in prose has not submitted anything. One
	// explicit continuation is cheaper and more reliable than a second process:
	// the findings are already in context, and the same tool set is active.
	pi.on("agent_before_settle", (event) => {
		if (nudged || submitted) return;
		if (event.outcome !== "completed") return;
		// Only a normal prose ending is drift. An error, abort, or output-length
		// stop has its own classification and cannot be fixed by a nudge.
		if (lastAssistant && lastAssistant.stopReason !== "stop") return;
		// Do not guard on `event.context.canContinue`: pi builds it from the
		// entries proposed *before* this handler, so it is false for a prose
		// ending. The `custom_message` returned below becomes a user-role
		// message, and pi recomputes `finalContext.canContinue` after committing
		// it, which makes the requested continuation valid.
		nudged = true;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "pi-review-nudge",
					content: NUDGE_MESSAGE,
					display: false,
				},
			],
			continue: true,
		};
	});

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
		const deps = env.PI_REVIEW_DEPS;
		const dependencies = deps === "installed" || deps === "unavailable" ? deps : undefined;
		const strictness =
			env.PI_REVIEW_STRICTNESS === "balanced" || env.PI_REVIEW_STRICTNESS === "thorough"
				? env.PI_REVIEW_STRICTNESS
				: "significant";
		const request = env.PI_REVIEW_REQUEST?.trim();
		// A screenshot in a `@pi` comment is the requester's evidence, and the
		// prompt alone cannot carry it. Only GitHub's own attachment hosts are
		// fetched, at most a handful, and a failure is a note rather than an error.
		const screenshots = request ? extractImages(request) : [];
		const downloaded =
			screenshots.length > 0
				? await fetchImages(screenshots, {
						fetchImpl,
						...(env.GH_TOKEN ? { token: env.GH_TOKEN } : {}),
					})
				: { images: [], notes: [] };
		const prompt = buildReviewPrompt(state.target, state.guidance, {
			...(dependencies ? { dependencies } : {}),
			strictness,
			...(resolveStaleThreads && state.threads.length > 0 ? { openThreads: state.threads } : {}),
			...(request ? { request } : {}),
			...(downloaded.images.length > 0 ? { images: downloaded.images } : {}),
			...(downloaded.notes.length > 0 ? { imageNotes: downloaded.notes } : {}),
		});
		return {
			systemPrompt: `${event.systemPrompt}\n\n${prompt.system}`,
			...(inject
				? {
						message: {
							customType: "pi-review-context",
							// A custom message's content is converted to a user message
							// for the model, so image parts ride along with the text.
							content: prompt.images
								? [{ type: "text" as const, text: prompt.context }, ...prompt.images.map((image) => ({
										type: "image" as const,
										data: image.data,
										mimeType: image.mimeType,
									}))]
								: prompt.context,
							display: false,
						},
					}
				: {}),
		};
	});

	const writeRunnerArtifact = async (details: Record<string, unknown>): Promise<void> => {
		if (!outputPath) return;
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, JSON.stringify(details, null, 2), "utf8");
	};

	// A run that never called submit_review leaves no artifact. Classify why,
	// then recover a substantive prose review as a COMMENT instead of losing it
	// (#27, #43). The artifact keeps `incomplete: true` so the run still says the
	// model drifted; `recovered` and `url` tell the workflow the review posted.
	pi.on("agent_settled", async () => {
		if (!outputPath) return;
		try {
			await access(outputPath);
			return;
		} catch {
			// No artifact: this run never reached submit_review.
		}

		const { target } = await load();
		const targetSummary = {
			repo: target.repo,
			number: target.number,
			baseRef: target.baseRef,
			headSha: target.headSha,
		};

		if (submitted) {
			// The review is already on GitHub. A failed artifact write must not
			// turn a posted review into a red check, and the workflow must not
			// retry it and post a duplicate.
			await writeRunnerArtifact({
				dryRun,
				...(dryRun
					? { incomplete: true, errorKind: "no-artifact" }
					: { submitted: true }),
				...(submittedReview ? { review: submittedReview } : {}),
				error: dryRun
					? "the dry-run review was validated but its artifact was not written"
					: "the review posted but its artifact was not written",
				target: targetSummary,
			});
			return;
		}

		const classification = classifySettlement(lastAssistant);
		const base = {
			dryRun,
			incomplete: true,
			errorKind: classification.kind,
			error: classification.detail,
			retryable: classification.retryable,
			target: targetSummary,
		};

		// A provider error, abort, or output limit is not a model that forgot to
		// submit. Never turn one into a review comment or a recovered summary.
		if (classification.kind !== "incomplete") {
			await writeRunnerArtifact(base);
			return;
		}

		// This prose is quoted from the diff and from tool output, and it is about to
		// be published under the reviewer's name: the artifact, the markdown and the
		// posted comment body all come from here. Scrub it once, at the source, so
		// the extension's own recovery cannot leak what the workflow's fallback
		// would have caught (#74). The workflow's fallback stays as a second belt.
		const raw = lastSubstantiveText || assistantText(lastAssistant);
		const text = redactSecrets(raw);
		if (!isSubstantiveReview(text)) {
			await writeRunnerArtifact({
				...base,
				error: `${classification.detail}; there was no substantive final answer to recover`,
			});
			return;
		}

		const review: ValidatedReview = {
			event: "COMMENT",
			summary: recoverySummary(text),
			comments: [],
			dropped: [],
		};
		const markdown = renderReviewMarkdown(review, {
			repo: target.repo,
			number: target.number,
			baseRef: target.baseRef,
			headSha: target.headSha,
			model: env.PI_MODEL,
		});
		const recovered = {
			...base,
			recovered: true,
			review,
			markdown,
			error: "the run ended without calling submit_review; its final answer was recovered as a COMMENT review",
		};
		// Write the review before the network call: if the process is killed
		// mid-post, the workflow can retry from this artifact.
		await writeRunnerArtifact(recovered);
		if (!post) return;
		try {
			const result = await post(review);
			await writeRunnerArtifact({
				...recovered,
				url: result.url,
				error: "the run ended without calling submit_review; its final answer was posted as a COMMENT review",
			});
		} catch (error) {
			const message = redactSecrets(error instanceof Error ? error.message : String(error));
			await writeRunnerArtifact({
				...recovered,
				errorKind: "post",
				error: `recovery could not post the final answer: ${message}`,
			});
		}
	});
}
