import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_DIVIDER,
	PRIDE_DIVIDER_ROLES,
	isPrideTheme,
	joinStatuses,
	sampleIndices,
} from "./divider.ts";

/** Theme role for the divider: a faint grey that reads as a separator. */
const DIVIDER_COLOR = "dim";

/**
 * The plain, faint separator.
 */
const plainDivider = (theme: Theme): string =>
	theme.fg(DIVIDER_COLOR, ` ${DEFAULT_DIVIDER} `);

/**
 * Recolour each separator glyph with the active flag's stripes. Sampling the
 * theme's own resolved colours keeps this in sync with the palette: the rainbow
 * theme yields a spectrum, a two-stripe flag alternates, and a three-stripe
 * flag shows all three.
 */
const flagDivider = (theme: Theme): string => {
	const characters = [...DEFAULT_DIVIDER];
	const ramp = PRIDE_DIVIDER_ROLES.map((role) => theme.colors[role]);
	const indices = sampleIndices(
		ramp.map((color) => String(color)),
		characters.length
	);
	if (indices.length === 0) {
		return plainDivider(theme);
	}
	return ` ${characters
		.map((character, index) =>
			theme.style(character, { fg: ramp[indices[index] as number] })
		)
		.join("")} `;
};

const dividerFor = (theme: Theme): string =>
	isPrideTheme(theme.name) ? flagDivider(theme) : plainDivider(theme);

/**
 * Pi joins extension statuses with a single space and exposes no separator
 * hook. The only supported way to interleave them is `ctx.ui.setFooter()`,
 * which replaces the whole footer.
 *
 * So this extension owns the footer while it is active, delegates every
 * non-status line back to pi's exported `FooterComponent`, and re-renders the
 * last (status) line with a divider between each item. Any other extension that
 * calls `setFooter()` will fight it; none of the status-only extensions do.
 */
export default function extensionDivider(pi: ExtensionAPI): void {
	let enabled = true;
	let installed = false;

	const install = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			return;
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			// FooterComponent reads a live AgentSession, which extensions cannot
			// reach. Back the fields it touches with ctx accessors. Only two have
			// no public equivalent and are stubbed: routed-model display and
			// subscription billing, neither of which this footer needs.
			const session = {
				get sessionManager() {
					return ctx.sessionManager;
				},
				get model() {
					return ctx.model;
				},
				get state() {
					return { model: ctx.model };
				},
				get routedModel() {
					return undefined;
				},
				modelRuntime: { isUsingSubscription: () => false },
				getContextUsage: () => ctx.getContextUsage(),
			};

			const builtIn = new FooterComponent(
				session as unknown as ConstructorParameters<typeof FooterComponent>[0],
				footerData
			);

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const lines = builtIn.render(width);
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size === 0 || lines.length === 0) {
						return lines;
					}
					const statusLine = joinStatuses(statuses, dividerFor(theme));
					// Pi appends the status line last; swap in our divided version.
					lines[lines.length - 1] = truncateToWidth(
						statusLine,
						width,
						theme.fg(DIVIDER_COLOR, "...")
					);
					return lines;
				},
			};
		});
		installed = true;
	};

	const remove = (ctx: ExtensionContext): void => {
		if (!installed) {
			return;
		}
		ctx.ui.setFooter(undefined);
		installed = false;
	};

	pi.on("session_start", (_event, ctx) => {
		if (enabled) {
			install(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		remove(ctx);
	});

	pi.registerCommand("divider", {
		description: "Toggle dividers between status line items",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(
					"Status dividers need the interactive terminal.",
					"info"
				);
				return;
			}
			enabled = !enabled;
			if (enabled) {
				install(ctx);
			} else {
				remove(ctx);
			}
			ctx.ui.notify(
				enabled ? "Status dividers on" : "Status dividers off",
				"info"
			);
		},
	});
}
