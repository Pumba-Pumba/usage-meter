# Design

usage-meter lives in the narrowest place in the app: one line of plain text under the prompt, beside the model name. It has no colors, no fonts and no layout, only characters, refreshed about once a second. This document explains how the ten designs work within that.

## The brief

Six words set the direction: **futuristic, electric, glass, light, smooth, seamless.**

| Word | What it became |
| --- | --- |
| Futuristic | Instrument glyphs (`⟡ ϟ ◈ ◐`) instead of everyday emoji. |
| Electric | A live waveform and a scanning spark: motion that reads as current flowing. |
| Glass | Beads that fill and empty (`○ ◔ ◑ ◕ ●`), and a translucent bar (`░ ▒ ▓ █`). |
| Light | Thin strokes (`━ ╸ ─`) and a travelling gleam (`✦`) rather than solid blocks. |
| Smooth | Partial fills: half-steps on lines, quarter-steps on beads, so nothing jumps in big chunks. |
| Seamless | Separators made of hairlines (`╱ ┊ ◦ ⟋ ⋮`) instead of boxes, so the line reads as one piece. |

## Principles

1. **Motion means "live".** A dynamic design moves only while the cache is warm. When the cache is cold, every design goes still: the line stops moving, which is the signal.
2. **Urgency is tempo, not color.** In the last 20% of the cache's life the animation runs twice as fast. You feel the deadline before you read it.
3. **Quiet by default, loud only when it matters.** Reset times appear only once a window is above 75% or on pace to run out. The `△ full 40m` forecast appears only when 100% would come before the reset.
4. **One line, always.** The desktop app shows one mod's status at a time, so cache and limits share a single line. The cache comes first because it changes fastest.
5. **Never twitch.** The line is sent to the app only when its text changes. A still design costs nothing between minutes.
6. **Honest uncertainty.** A `?` marks a figure that is assumed rather than known (the cache lifetime, until it has been learned).

## Glyph vocabulary

| Purpose | Glyphs | Used in |
| --- | --- | --- |
| Line gauge | `━` full, `╸` half, `─` empty | aurora, blueprint |
| Bead gauge | `○ ◔ ◑ ◕ ●`, `◌` empty slot | glass |
| Segment gauge | `▰` full, `▱` empty | flux, bars |
| Density gauge | `░ ▒ ▓ █` | prism |
| Level mark | `▁ ▂ ▃ ▄ ▅ ▆ ▇ █` | pulse |
| Waveform | `⎺ ⎻ ⎼ ⎽`, `⎯` flat | pulse |
| Spinner | `◜ ◝ ◞ ◟` · `◇ ◈ ◆` · `◐ ◓ ◑ ◒` | aurora · glass · prism |
| Spark | `✦` gleam · `●•∙` scanning spark | aurora · flux |
| Signals | `?` assumed · `↺` re-cache · `↻` reset · `△` forecast risk | all designs |

## The dynamic designs

**aurora: light.** An orbit (`◜◝◞◟`) turns at the head of a thin line of light. A gleam (`✦`) travels only through the lit part, so as the cache drains the gleam's path shortens with it. This is the default because it's the calmest of the moving designs.

**pulse: electric.** A six-step waveform scrolls continuously. Below 20% it flattens to a small ripple, so the signal visibly weakens. Cold, it becomes a flat line: `⌁ offline ⎯⎯⎯⎯`. The limits read like vital signs, one level mark each.

**glass: glass.** The cache is five beads that empty a quarter at a time. The last full bead shimmers (`● ↔ ◉`), and a diamond breathes (`◇ ◈ ◆ ◈`). The limit gauges use the same beads with dotted empty slots (`◌`), so filling and emptying read as one material.

**flux: futuristic.** A spark with a soft tail (`∙•●•∙`) glides back and forth along a track, like a scanner. Near expiry it moves two steps a frame. The limits use crisp segments (`▰▱`).

**prism: glass, light.** The cache is a translucent bar. A bright band (`▒▓█▓▒`) travels through its lit part while a prism (`◐◓◑◒`) turns. Cold, the bar is fully clear (`░`).

## The static designs

**classic** shows every number with a traffic-light dot. **bars** is the at-a-glance gauge view. **icons** is the shortest. **minimal** is words only, with color appearing just where attention is needed. **blueprint** is aurora's line gauges with the motion removed, for people who like the look but not the movement.

## States

Every design draws four states from the same snapshot:

| State | When | Example (aurora) |
| --- | --- | --- |
| Empty | No reply yet and no limit figures | *(no line)* |
| Warm | Cache within its lifetime | `◜ 52m ✦━━━━━━━╸─` |
| Closing | Last 20% of the lifetime: faster motion, plus one toast at 10% | `◞ 4m ━─────────` |
| Cold | Lifetime passed | `◌ dim ────────── 84k to relight` |

## Timing

- **Frame:** 800 ms, fast enough to read as motion and slow enough not to distract. Most designs advance every other frame (1.6 s per step), and every frame near expiry.
- **Loops:** each design's animation repeats seamlessly. `scripts/gallery.mjs` finds the shortest repeating loop and renders exactly that.

## Adding a design

A design is a pure function `(snapshot, frame) => string | undefined` in `hooks/themes.ts`, plus `motion` (`static` or `dynamic`) and a one-line `blurb`. Keep to the principles above, add it to `THEMES`, run `claude plugin test .`, then `node scripts/gallery.mjs`. Details are in [CONTRIBUTING.md](../CONTRIBUTING.md).
