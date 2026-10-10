# Pride themes

A pack of eight [pi themes](https://github.com/earendil-works/pi/blob/main/docs/themes.md):
four flags, each in a light and dark variant.

| Theme | Flag | Dark | Light |
| --- | --- | --- | --- |
| `pride` | Progress Pride (rainbow) | `pride-dark` | `pride-light` |
| `pride-trans` | Transgender | `pride-trans-dark` | `pride-trans-light` |
| `pride-bi` | Bisexual | `pride-bi-dark` | `pride-bi-light` |
| `pride-pan` | Pansexual | `pride-pan-dark` | `pride-pan-light` |

The rainbow theme is the calm default: near-neutral body text with the spectrum
reserved for syntax, markdown, the accent frame and the thinking ramp. The flag
themes keep the same role map and swap the spectrum for two or three flag
stripes, so they read as a deliberate palette rather than a rainbow with a
filter on it.

## Install

The pack ships with the `pi-extensions` package, so installing the package is
enough:

```bash
pi install git:github.com/AutumnsGrove/pi-extensions
```

Then pick a theme in `/settings` → **Theme**, or set it directly. Each variant
is a separate theme, so automatic light/dark switching points at a pair:

```json
{
  "theme": "pride-light/pride-dark"
}
```

Other pairs follow the same pattern, e.g. `"pride-trans-light/pride-trans-dark"`.

To try it without installing the package, drop a single `.json` into
`~/.pi/agent/themes/`; pi hot-reloads a user theme with the same name.

## Design rules

Each theme is generated from one flag and one appearance. The rules live in
[`palettes.ts`](./palettes.ts) and are the same for every variant:

- **Neutral body.** Text, chrome and surfaces are tinted only a few points
  toward the flag. Body copy stays legible and calm.
- **Flag where it shows.** `syntax*`, `md*`, `accent`, `border*` and the
  `thinkingOff → thinkingMax` ramp cycle the flag's stripes. This is where the
  flag actually reads.
- **Honest semantics.** `success`, `error` and `warning` keep conventional
  green/red/yellow hues so tool states stay readable regardless of the flag.
- **Contrast floor.** Every foreground is pushed away from the brightest
  surface until it clears a WCAG floor: body text 7:1, secondary text 4.5:1,
  faint text 3.5:1, chromatic text 4.5:1. An 8-bit safety margin keeps the
  emitted hex above the floor after rounding.

## Regenerate

The JSON files are committed and loaded directly by pi. They are produced from
`palettes.ts` so all eight stay consistent:

```bash
pnpm themes          # write themes/*.json and print a contrast report
pnpm themes:check    # fail if the committed files are stale
node themes/generate.ts --check
```

`pnpm test` covers the colour maths, the contrast floors and an up-to-date
check of the committed files, so editing `palettes.ts` without regenerating
fails CI.

### Add a flag

1. Add a `FlagSpec` to `FLAGS` in [`palettes.ts`](./palettes.ts) with its
   stripes in visual order (index 0 becomes the accent).
2. `pnpm themes` to write the two new files.
3. Add a row to the table above and to the theme list in the repository README.
