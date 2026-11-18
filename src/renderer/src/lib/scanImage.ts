/**
 * The arithmetic of preparing a receipt image for the AI reading, kept apart
 * from the DOM (scanImageDom.ts) so it can be tested: how far to scale it
 * down, what kind of file it is, and the JPEG quality steps tried until it
 * fits. The image is never stored: it goes from the file picker to the
 * request and to a preview, and nowhere else.
 */

/** The long edge the image is scaled down to (Claude reads ~1.15 megapixels; more only costs tokens). */
export const SCAN_MAX_EDGE = 1600
/** The base64 size aimed for (≈1.1 MB of JPEG), under the function's 1.6 M cap. */
export const SCAN_TARGET_BASE64 = 1_500_000
/** A file bigger than this is refused before it is decoded. */
export const SCAN_MAX_FILE_BYTES = 30 * 1024 * 1024

/** The size within `maxEdge` on the long side, never larger than it was; integers ≥ 1. */
export function fitWithin(width: number, height: number, maxEdge: number = SCAN_MAX_EDGE): { width: number; height: number; scale: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1
  const h = Number.isFinite(height) && height > 0 ? height : 1
  const long = Math.max(w, h)
  const scale = long > maxEdge ? maxEdge / long : 1
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale }
}

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'heic' | 'avif' | 'other'

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/**
 * FF D8 FF; 89 50 4E 47; "RIFF"…"WEBP"; "GIF8"; ISO-BMFF "ftyp" at 4–7 with the major brand at 8–11 and compatible brands after:
 * heic|heix|hevc|hevx|heim|heis|hevm|hevs|msf1 → heic; avif|avis → avif; mif1 → avif when "avif" is among the compatible
 * brands in the first 32 bytes, else heic.
 */
export function sniffImage(head: Uint8Array): ImageKind {
  const ascii = (from: number, to: number): string => String.fromCharCode(...head.slice(from, to))
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (ascii(0, 4) === 'GIF8') return 'gif'
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const major = ascii(8, 12)
    if (HEIC_BRANDS.has(major)) return 'heic'
    if (AVIF_BRANDS.has(major)) return 'avif'
    if (major === 'mif1') {
      // Compatible brands: 4 bytes each from byte 16 (12–15 is the minor version), within the first 32 bytes.
      for (let at = 16; at + 4 <= Math.min(32, head.length); at += 4) if (ascii(at, at + 4) === 'avif') return 'avif'
      return 'heic'
    }
  }
  return 'other'
}

export interface EncodeStep {
  /** Of the fitted size. */
  scale: number
  quality: number
}

/** Tried in order until the JPEG fits SCAN_TARGET_BASE64: lower quality first, then smaller. */
export const ENCODE_LADDER: readonly EncodeStep[] = [
  { scale: 1, quality: 0.85 },
  { scale: 1, quality: 0.75 },
  { scale: 1, quality: 0.65 },
  { scale: 0.8, quality: 0.7 },
  { scale: 0.64, quality: 0.65 }
]

/** The base64 of a data: URL (after the first comma): what the request carries. */
export const base64OfDataUrl = (dataUrl: string): string => dataUrl.slice(dataUrl.indexOf(',') + 1)

/** Its length in characters: what the caps count. */
export const base64Size = (b64: string): number => b64.length
