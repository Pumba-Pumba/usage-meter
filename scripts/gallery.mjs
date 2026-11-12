// Renders docs/gallery.svg and one SVG per design from the mod's own
// renderers, so the pictures in the README can never drift from the code.
//
//   node scripts/gallery.mjs
//
// Node 22.18+ runs the TypeScript sources directly (type stripping). The
// hooks import their neighbours without an extension, as the engine allows,
// so they are copied to a temporary folder with `.ts` added to each import.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hooks = join(root, 'hooks')
const out = join(root, 'docs')
const tmp = mkdtempSync(join(tmpdir(), 'usage-meter-gallery-'))

for (const file of ['cache.ts', 'limits.ts', 'price.ts', 'themes.ts']) {
  const src = readFileSync(join(hooks, file), 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.ts'")
  writeFileSync(join(tmp, file), src)
}
const { DYNAMIC, STATIC, SAMPLE, render, blurb } = await import(pathToFileURL(join(tmp, 'themes.ts')).href)

const FRAME_S = 0.8
const MAX_FRAMES = 48

/** The shortest loop of frames that repeats seamlessly. */
const frames = name => {
  const all = Array.from({ length: MAX_FRAMES * 2 }, (_, f) => render(name, SAMPLE, f))
  for (let len = 1; len <= MAX_FRAMES; len++) {
    if (all.slice(0, MAX_FRAMES).every((t, i) => t === all[i + len])) return all.slice(0, len)
  }
  return all.slice(0, MAX_FRAMES)
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FONT = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace"
const W = 880
const ROW_H = 58

/** One design: a dark status-bar strip, its name, and its frames cycling. */
const row = (name, y) => {
  const list = frames(name)
  const dur = (list.length * FRAME_S).toFixed(1)
  const texts = list
    .map((text, i) => {
      if (list.length === 1) return `<text x="20" y="${y + 39}" class="line">${esc(text)}</text>`
      const values = list.map((_, j) => (j === i ? 1 : 0)).join(';')
      return `<text x="20" y="${y + 39}" class="line" opacity="${i === 0 ? 1 : 0}"><animate attributeName="opacity" values="${values}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>${esc(text)}</text>`
    })
    .join('')
  return `<g><rect x="0" y="${y}" width="${W}" height="${ROW_H - 8}" rx="10" class="bar"/><text x="20" y="${y + 18}" class="name">${name} · ${esc(blurb(name))}</text>${texts}</g>`
}

const STYLE = `<style>
.bar{fill:#16171b;stroke:#2a2c33;stroke-width:1}
.name{font:500 11px ${FONT};fill:#8b8f9a;letter-spacing:.2px}
.line{font:14px ${FONT};fill:#e9ebf0;white-space:pre}
.head{font:500 13px ${FONT};fill:#8b8f9a}
@media (prefers-color-scheme: light){.head{fill:#57606a}}
</style>`

const svg = (height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">${STYLE}${body}</svg>\n`

mkdirSync(join(out, 'designs'), { recursive: true })
for (const f of readdirSync(join(out, 'designs'))) rmSync(join(out, 'designs', f))

let y = 0
let body = ''
for (const [title, names] of [['Dynamic — animated while the cache is warm', DYNAMIC], ['Static — never moves', STATIC]]) {
  body += `<text x="4" y="${y + 16}" class="head">${esc(title)}</text>`
  y += 28
  for (const name of names) {
    body += row(name, y)
    writeFileSync(join(out, 'designs', `${name}.svg`), svg(ROW_H - 8, row(name, 0)))
    y += ROW_H
  }
  y += 10
}
writeFileSync(join(out, 'gallery.svg'), svg(y, body))
rmSync(tmp, { recursive: true, force: true })
console.log(`wrote docs/gallery.svg and ${DYNAMIC.length + STATIC.length} designs in docs/designs/`)
