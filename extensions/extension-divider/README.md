# extension-divider

A light grey `///` between each item on pi's extension status line, so several
status badges read as distinct instead of running together. Under a
[pride theme](../../themes/) the separator is recoloured from the active flag.

```
~/Documents/Projects/pi-extensions (main)
↑1.2k ↓300 $0.010 12.3%/128k (auto)
pin: DeepSeek /// DS off-peak 2d3h /// parallel 12/4000 · $0.03
```

## Usage

Always on in the terminal. `/divider` toggles it; the built-in footer returns
when it is off.

When the active theme belongs to the pride pack, each `/` is drawn in a colour
from that flag: `pride` shows a spectrum, a two-stripe flag alternates, a
three-stripe flag shows all three. Under every other theme the divider stays
the usual faint grey. The colours are read from the theme itself (the `syntax*`
roles), so no palette is hard-coded here and a new flag works automatically.

## How it works (and the one caveat)

Pi's footer joins every `ctx.ui.setStatus()` value with a single space and
offers no separator hook. The only supported way to interleave them is
`ctx.ui.setFooter()`, which **replaces the whole footer**.

So while this extension is on it owns the footer: it delegates every non-status
line back to pi's exported `FooterComponent` and rewrites only the last
(status) line. That means:

- The pwd/branch, token, cost, context and model lines are pi's own, not a
  reimplementation.
- It reads the live session through `ctx` accessors, so model changes and new
  messages update as usual.
- Two fields have no public extension equivalent and are stubbed: the
  routed-model suffix and subscription billing. They do not appear.
- Another extension that also calls `setFooter()` will fight this one (the last
  call wins). Status-only extensions such as `parallel` and `provider-pinning`
  are unaffected.

If a future pi release gains a status-separator option, this extension should be
deleted in favour of it.
