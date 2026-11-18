import { base64OfDataUrl, base64Size, ENCODE_LADDER, fitWithin, SCAN_MAX_FILE_BYTES, SCAN_TARGET_BASE64, sniffImage } from './scanImage'

/**
 * A picked, pasted or dropped image made ready for the AI reading: decoded,
 * turned upright, scaled down to SCAN_MAX_EDGE and re-encoded as JPEG small
 * enough for the request. Re-encoding drops EXIF and GPS. Nothing is stored:
 * the data URL is both the preview's `src` and the request's payload, and it
 * lives in memory only. No `blob:` URL anywhere (the CSP allows `data:` images
 * only). The arithmetic is in scanImage.ts (unit-tested); this part needs a
 * browser and is covered by the e2e suite.
 */

export interface PreparedImage {
  dataUrl: string
  base64: string
  mediaType: 'image/jpeg'
  width: number
  height: number
}

export type PrepareError = 'too_large' | 'unsupported' | 'heic' | 'unreadable'

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'))
    reader.readAsDataURL(blob)
  })
}

interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  close(): void
}

const fromBitmap = (bitmap: ImageBitmap): Decoded => ({ source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() })

/** The image decoded, the way the engine can: an upright ImageBitmap, a plain one, or an <img> from a data URL. Null when none can. */
async function decode(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return fromBitmap(await createImageBitmap(file, { imageOrientation: 'from-image' }))
    } catch (err) {
      // An engine that rejects the option: without it (it applies EXIF orientation by default nowadays).
      if (err instanceof TypeError) {
        try {
          return fromBitmap(await createImageBitmap(file))
        } catch {
          // Next way.
        }
      }
    }
  }
  try {
    const img = new Image()
    img.src = await readAsDataUrl(file)
    await img.decode()
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => img.removeAttribute('src') }
  } catch {
    return null
  }
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // A transparent PNG would turn black as a JPEG.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

/** Asynchronous, so a phone doesn't freeze for a second while it encodes. */
const toJpeg = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))

/**
 * The file as a JPEG within the request's size, or why not: too_large (a file over 30 MB, or one no step of the
 * ladder gets small enough), unsupported (not an image this app reads), heic (a HEIC photo this engine can't
 * decode), unreadable (an image that won't decode or encode).
 */
export async function prepareScanImage(file: Blob): Promise<{ ok: true; image: PreparedImage } | { ok: false; code: PrepareError }> {
  if (file.size > SCAN_MAX_FILE_BYTES) return { ok: false, code: 'too_large' }
  let kind: ReturnType<typeof sniffImage>
  try {
    kind = sniffImage(new Uint8Array(await file.slice(0, 32).arrayBuffer()))
  } catch {
    return { ok: false, code: 'unreadable' }
  }
  // Something else that says it is an image is tried anyway (a format this engine may know); anything else is not.
  if (kind === 'other' && !file.type.startsWith('image/')) return { ok: false, code: 'unsupported' }
  const decoded = await decode(file)
  if (!decoded) return { ok: false, code: kind === 'heic' ? 'heic' : kind === 'jpeg' || kind === 'png' || kind === 'webp' ? 'unreadable' : 'unsupported' }

  // Drawn once at the fitted size (and the decoded image let go at once); the ladder's smaller steps draw from that.
  const fit = fitWithin(decoded.width, decoded.height)
  const base = canvasOf(fit.width, fit.height)
  if (!base) {
    decoded.close()
    return { ok: false, code: 'unreadable' }
  }
  base.ctx.drawImage(decoded.source, 0, 0, fit.width, fit.height)
  decoded.close()

  try {
    for (const step of ENCODE_LADDER) {
      const width = Math.max(1, Math.round(fit.width * step.scale))
      const height = Math.max(1, Math.round(fit.height * step.scale))
      let canvas = base.canvas
      if (step.scale !== 1) {
        const smaller = canvasOf(width, height)
        if (!smaller) return { ok: false, code: 'unreadable' }
        smaller.ctx.drawImage(base.canvas, 0, 0, width, height)
        canvas = smaller.canvas
      }
      const blob = await toJpeg(canvas, step.quality)
      if (!blob) return { ok: false, code: 'unreadable' }
      const dataUrl = await readAsDataUrl(blob)
      const base64 = base64OfDataUrl(dataUrl)
      if (base64Size(base64) <= SCAN_TARGET_BASE64) return { ok: true, image: { dataUrl, base64, mediaType: 'image/jpeg', width, height } }
    }
  } catch {
    // A canvas the engine can't draw or encode (out of memory on a small phone).
    return { ok: false, code: 'unreadable' }
  }
  return { ok: false, code: 'too_large' }
}
