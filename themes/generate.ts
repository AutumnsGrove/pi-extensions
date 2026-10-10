/**
 * Generate the pride theme pack from `palettes.ts`.
 *
 *   node themes/generate.ts          # write themes/*.json and print a report
 *   node themes/generate.ts --check  # fail if the files on disk are stale
 *
 * The JSON files are committed and loaded directly by pi; this script only
 * exists so all eight variants share one reviewable source of truth.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Rgb, contrastRatio, hexToRgb } from "./color.ts";
import {
	type Appearance,
	CONTRAST,
	FLAGS,
	type GeneratedTheme,
	generateTheme,
} from "./palettes.ts";

export const APPEARANCES: readonly Appearance[] = ["dark", "light"];
export const THEMES_DIR = dirname(fileURLToPath(import.meta.url));

/** Every theme in the pack, in a stable order. */
export function generateAll(): GeneratedTheme[] {
	return FLAGS.flatMap((flag) =>
		APPEARANCES.map((appearance) => generateTheme(flag, appearance))
	);
}

export function themePath(theme: GeneratedTheme): string {
	return join(THEMES_DIR, `${theme.name}.json`);
}

/** Canonical on-disk form: tabs and a trailing newline, like pi's own themes. */
export function serialize(theme: GeneratedTheme): string {
	return `${JSON.stringify(theme, null, "\t")}\n`;
}

/** Foregrounds worth checking, mapped to the WCAG floor they must clear. */
const FOREGROUND_FLOORS: Record<string, number> = {
	text: CONTRAST.text,
	userMessageText: CONTRAST.text,
	toolTitle: CONTRAST.text,
	muted: CONTRAST.muted,
	dim: CONTRAST.dim,
	thinkingText: CONTRAST.muted,
	toolOutput: CONTRAST.muted,
	accent: CONTRAST.chromatic,
	mdHeading: CONTRAST.chromatic,
	mdLink: CONTRAST.chromatic,
	mdCode: CONTRAST.chromatic,
	success: CONTRAST.chromatic,
	error: CONTRAST.chromatic,
	warning: CONTRAST.chromatic,
	syntaxKeyword: CONTRAST.chromatic,
	syntaxFunction: CONTRAST.chromatic,
	syntaxVariable: CONTRAST.chromatic,
	syntaxString: CONTRAST.chromatic,
	syntaxNumber: CONTRAST.chromatic,
	syntaxType: CONTRAST.chromatic,
};

/** Background roles a foreground may be drawn on. */
const BACKGROUNDS = [
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"selectedBg",
	"searchMatchBg",
] as const;

export interface ContrastFailure {
	theme: string;
	foreground: string;
	background: string;
	ratio: number;
	floor: number;
}

/**
 * Check every foreground against every background and the exported
 * page/card backgrounds, returning anything below its floor.
 */
export function contrastFailures(theme: GeneratedTheme): ContrastFailure[] {
	const backgrounds: Array<[string, Rgb]> = BACKGROUNDS.map((role) => [
		role,
		hexToRgb(theme.colors[role] ?? "black"),
	]);
	backgrounds.push(["export.pageBg", hexToRgb(theme.export.pageBg ?? "black")]);
	backgrounds.push(["export.cardBg", hexToRgb(theme.export.cardBg ?? "black")]);

	const failures: ContrastFailure[] = [];
	for (const [foreground, floor] of Object.entries(FOREGROUND_FLOORS)) {
		const color = theme.colors[foreground];
		if (color === undefined) {
			continue;
		}
		for (const [background, backgroundRgb] of backgrounds) {
			const ratio = contrastRatio(hexToRgb(color), backgroundRgb);
			if (ratio + 1e-6 < floor) {
				failures.push({ theme: theme.name, foreground, background, ratio, floor });
			}
		}
	}
	return failures;
}

function writeThemes(): GeneratedTheme[] {
	mkdirSync(THEMES_DIR, { recursive: true });
	const themes = generateAll();
	for (const theme of themes) {
		writeFileSync(themePath(theme), serialize(theme));
	}
	return themes;
}

function checkThemes(themes: GeneratedTheme[]): boolean {
	let ok = true;
	for (const theme of themes) {
		let onDisk: string;
		try {
			onDisk = readFileSync(themePath(theme), "utf8");
		} catch {
			console.error(`missing: ${theme.name}.json`);
			ok = false;
			continue;
		}
		if (onDisk !== serialize(theme)) {
			console.error(`stale:   ${theme.name}.json (run node themes/generate.ts)`);
			ok = false;
		}
	}
	return ok;
}

function report(themes: GeneratedTheme[]): void {
	for (const theme of themes) {
		const rows = Object.entries(FOREGROUND_FLOORS).map(([role, floor]) => {
			const color = theme.colors[role];
			const ratio =
				color === undefined
					? Number.NaN
					: Math.min(
							...BACKGROUNDS.map((background) =>
								contrastRatio(
									hexToRgb(color),
									hexToRgb(theme.colors[background] ?? "black")
								)
							)
						);
			return { role, ratio, floor };
		});
		const worst = rows.reduce((a, b) => (a.ratio < b.ratio ? a : b));
		console.log(
			`${theme.name.padEnd(20)} accent ${theme.colors.accent}  ` +
				`worst ${worst.role} ${worst.ratio.toFixed(2)}:1 (floor ${worst.floor})`
		);
	}
}

const isMain =
	process.argv[1] !== undefined &&
	pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
	const check = process.argv.includes("--check");
	const themes = check ? generateAll() : writeThemes();
	const failures = themes.flatMap(contrastFailures);
	report(themes);

	if (failures.length > 0) {
		console.error(`\n${failures.length} contrast failure(s):`);
		for (const failure of failures.slice(0, 20)) {
			console.error(
				`  ${failure.theme}: ${failure.foreground} on ${failure.background} ` +
					`is ${failure.ratio.toFixed(2)}:1 (needs ${failure.floor})`
			);
		}
		process.exitCode = 1;
	} else if (check && !checkThemes(themes)) {
		process.exitCode = 1;
	} else {
		console.log(
			`\n${themes.length} themes ${check ? "up to date" : "written"}; contrast ok`
		);
	}
}
