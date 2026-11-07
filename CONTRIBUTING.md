# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

You need Claude Code (2.1.317 or newer) and, for the pictures, Node 22.18 or newer.

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .    # try your working copy in a session
```

## Ground rules

- **Stay safe to install.** No `$.http`, `$.fs`, `$.process`, `$.env`, `$.model` or `$.tool`. No reading credentials, message text or files. A pull request that adds any of these will be declined.
- **Keep logic pure.** `cache.ts`, `limits.ts` and `themes.ts` take no `$`, so they're testable in isolation. Only `register.tsx` talks to the engine.
- **Test what you change.** Add a case to `hooks/register.test.ts`.

## Adding a design

1. In `hooks/themes.ts`, write a `Theme`: `motion` (`'static'` or `'dynamic'`), a one-line `blurb`, and `render(snapshot, frame)`.
2. Draw all four states: warm, closing (`frac < 0.2`), cold, and empty (return `undefined` when there's nothing to show).
3. Follow [docs/DESIGN.md](docs/DESIGN.md). Motion only while warm, faster near expiry, quiet unless it matters, one line.
4. Add it to `THEMES` and update the expectations in the "five dynamic and five static designs" test.
5. Run `node scripts/gallery.mjs` and commit the regenerated SVGs.

## Commit style

Short imperative subject lines, for example "Add nebula design" or "Fix forecast at window start".
