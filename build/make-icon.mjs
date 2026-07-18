// Generates every app/PWA icon from one vector recipe: a dark tile with a
// neon-green upward trend line. Rendered at 3x and box-downsampled for AA.
// Pure Node (zlib), no image libraries. Regenerate: node build/make-icon.mjs
//
// Outputs:
//   build/icon.png                              (electron-builder, 512, rounded)
//   src/renderer/public/pwa-192.png             (PWA, rounded)
//   src/renderer/public/pwa-512.png             (PWA, rounded)
//   src/renderer/public/maskable-512.png        (PWA maskable, full-bleed)
//   src/renderer/public/apple-touch-icon.png    (iOS home screen, full-bleed)
//   src/renderer/public/favicon.svg             (browser tab)
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const green = [0, 229, 125]

function render(OUT, { fullBleed }) {
  const SS = 3
  const S = OUT * SS
  const buf = new Uint8Array(S * S * 4)

  const px = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return
    const i = (y * S + x) * 4
    const ia = a / 255
    buf[i] = r * ia + buf[i] * (1 - ia)
    buf[i + 1] = g * ia + buf[i + 1] * (1 - ia)
    buf[i + 2] = b * ia + buf[i + 2] * (1 - ia)
    buf[i + 3] = Math.max(buf[i + 3], a)
  }

  const radius = fullBleed ? 0 : 0.22 * S
  const top = [20, 27, 36]
  const bot = [10, 16, 21]
  for (let y = 0; y < S; y++) {
    const t = y / S
    const col = [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t, 255]
    for (let x = 0; x < S; x++) {
      if (radius > 0) {
        const cx = Math.min(Math.max(x, radius), S - radius)
        const cy = Math.min(Math.max(y, radius), S - radius)
        const inCorner = (x < radius || x > S - radius) && (y < radius || y > S - radius)
        if (inCorner && (x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue
      }
      px(x, y, col)
    }
  }

  // Trend line in a padded plot box. Maskable/full-bleed insets more so the
  // line stays inside the mask safe zone.
  const inset = (fullBleed ? 0.26 : 0.16) * S
  const plot = (nx, ny) => [inset + nx * (S - 2 * inset), inset + ny * (S - 2 * inset)]
  const pts = [
    [0.0, 0.78],
    [0.22, 0.6],
    [0.4, 0.68],
    [0.62, 0.36],
    [0.8, 0.44],
    [1.0, 0.14]
  ]
  const half = (fullBleed ? 0.028 : 0.022) * S

  const disc = (cx, cy, rad) => {
    for (let oy = -Math.ceil(rad); oy <= rad; oy++) {
      for (let ox = -Math.ceil(rad); ox <= rad; ox++) {
        const d = Math.hypot(ox, oy)
        if (d > rad) continue
        const a = d > rad - SS ? (255 * (rad - d)) / SS : 255
        px(Math.round(cx + ox), Math.round(cy + oy), [...green, a])
      }
    }
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = plot(...pts[i])
    const [x1, y1] = plot(...pts[i + 1])
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
    for (let s = 0; s <= steps; s++) disc(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, half)
  }
  const [ex, ey] = plot(...pts[pts.length - 1])
  disc(ex, ey, half * 1.7)

  // downsample SS -> 1
  const out = new Uint8Array(OUT * OUT * 4)
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]
        }
      }
      const n = SS * SS
      const o = (y * OUT + x) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
    }
  }
  return encodePng(OUT, out)
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (data) => {
  let c = 0xffffffff
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, i) => {
      raw[y * (size * 4 + 1) + 1 + i] = v
    })
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0d1319"/>
  <polyline points="10,44 22,34 30,39 44,22 54,28"
    fill="none" stroke="#00e57d" stroke-width="5"
    stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="54" cy="28" r="4.5" fill="#00e57d"/>
</svg>
`

const pub = join(root, 'src/renderer/public')
mkdirSync(pub, { recursive: true })
mkdirSync(join(root, 'build'), { recursive: true })

const targets = [
  [join(root, 'build/icon.png'), 512, false],
  [join(pub, 'pwa-192.png'), 192, false],
  [join(pub, 'pwa-512.png'), 512, false],
  [join(pub, 'maskable-512.png'), 512, true],
  [join(pub, 'apple-touch-icon.png'), 180, true]
]
for (const [path, size, fullBleed] of targets) {
  writeFileSync(path, render(size, { fullBleed }))
  console.log(`wrote ${path.replace(root + '/', '')} (${size}x${size})`)
}
writeFileSync(join(pub, 'favicon.svg'), favicon)
console.log('wrote src/renderer/public/favicon.svg')
