// Generates build/icon.png (512x512) — a dark rounded tile with a neon-green
// upward trend line, matching the app's sportsbook look. Rendered at 3x and
// box-downsampled for anti-aliasing. Pure Node (zlib), no image libraries.
// Regenerate with: node build/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = 512
const SS = 3
const S = OUT * SS

const buf = new Uint8Array(S * S * 4) // RGBA

const px = (x, y, [r, g, b, a]) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  const ia = a / 255
  buf[i] = r * ia + buf[i] * (1 - ia)
  buf[i + 1] = g * ia + buf[i + 1] * (1 - ia)
  buf[i + 2] = b * ia + buf[i + 2] * (1 - ia)
  buf[i + 3] = Math.max(buf[i + 3], a)
}

// rounded-rect background
const pad = 0
const radius = 112 * SS
const inset = pad * SS
const top = [20, 27, 36, 255]
const bot = [10, 16, 21, 255]
for (let y = 0; y < S; y++) {
  const t = y / S
  const col = [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t, 255]
  for (let x = 0; x < S; x++) {
    const cx = Math.min(Math.max(x, inset + radius), S - inset - radius)
    const cy = Math.min(Math.max(y, inset + radius), S - inset - radius)
    const dx = x - cx
    const dy = y - cy
    const inCorner = (x < inset + radius || x > S - inset - radius) && (y < inset + radius || y > S - inset - radius)
    if (inCorner && dx * dx + dy * dy > radius * radius) continue
    if (x < inset || y < inset || x >= S - inset || y >= S - inset) continue
    px(x, y, col)
  }
}

// neon-green trend polyline (normalized 0..1 within a padded plot box)
const green = [0, 229, 125]
const pts = [
  [0.16, 0.68],
  [0.32, 0.55],
  [0.44, 0.62],
  [0.58, 0.4],
  [0.72, 0.46],
  [0.86, 0.24]
]
const plot = (nx, ny) => [inset + nx * (S - 2 * inset), inset + ny * (S - 2 * inset)]
const half = 11 * SS

const stroke = (x0, y0, x1, y1) => {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
  for (let s = 0; s <= steps; s++) {
    const cx = x0 + ((x1 - x0) * s) / steps
    const cy = y0 + ((y1 - y0) * s) / steps
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const d = Math.hypot(ox, oy)
        if (d > half) continue
        const a = d > half - SS ? 255 * (half - d) / SS : 255
        px(Math.round(cx + ox), Math.round(cy + oy), [...green, a])
      }
    }
  }
}
for (let i = 0; i < pts.length - 1; i++) {
  const [x0, y0] = plot(...pts[i])
  const [x1, y1] = plot(...pts[i + 1])
  stroke(x0, y0, x1, y1)
}
// end dot
const [ex, ey] = plot(...pts[pts.length - 1])
const dotR = 20 * SS
for (let oy = -dotR; oy <= dotR; oy++) {
  for (let ox = -dotR; ox <= dotR; ox++) {
    const d = Math.hypot(ox, oy)
    if (d > dotR) continue
    const a = d > dotR - SS ? 255 * (dotR - d) / SS : 255
    px(Math.round(ex + ox), Math.round(ey + oy), [...green, a])
  }
}

// box-downsample SS -> 1
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

// encode PNG
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
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(OUT, 0)
ihdr.writeUInt32BE(OUT, 4)
ihdr[8] = 8
ihdr[9] = 6
const raw = Buffer.alloc(OUT * (OUT * 4 + 1))
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0
  out.subarray(y * OUT * 4, (y + 1) * OUT * 4).forEach((v, i) => {
    raw[y * (OUT * 4 + 1) + 1 + i] = v
  })
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
const dir = dirname(fileURLToPath(import.meta.url))
writeFileSync(join(dir, 'icon.png'), png)
console.log(`wrote build/icon.png (${OUT}x${OUT}, ${png.length} bytes)`)
