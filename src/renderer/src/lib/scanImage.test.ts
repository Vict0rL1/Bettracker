import { describe, expect, it } from 'vitest'
import { base64OfDataUrl, base64Size, ENCODE_LADDER, fitWithin, SCAN_MAX_EDGE, SCAN_TARGET_BASE64, sniffImage } from './scanImage'

const bytes = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = []
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))
  while (out.length < 32) out.push(0)
  return new Uint8Array(out)
}
/** An ISO-BMFF head: size, "ftyp", major brand, minor version, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => bytes([0, 0, 0, 0x1c], 'ftyp', major, [0, 0, 0, 0], ...compatible)

describe('fitWithin', () => {
  it('scales the long edge down to the cap, keeping the shape', () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600, scale: 1600 / 4032 })
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200, scale: 1600 / 4032 })
    expect(fitWithin(1179, 2556).height).toBe(SCAN_MAX_EDGE)
  })

  it('never scales up', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scale: 1 })
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600, scale: 1 })
  })

  it('whole pixels, at least 1', () => {
    expect(fitWithin(10_000, 3)).toEqual({ width: 1600, height: 1, scale: 0.16 })
    expect(fitWithin(1601, 1001, 1600).height).toBe(1000)
    expect(fitWithin(0, Number.NaN)).toEqual({ width: 1, height: 1, scale: 1 })
  })
})

describe('sniffImage', () => {
  it('knows the common kinds by their first bytes', () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe1]))).toBe('jpeg')
    expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('webp')
    expect(sniffImage(bytes('GIF89a'))).toBe('gif')
    expect(sniffImage(bytes('%PDF-1.7'))).toBe('other')
    expect(sniffImage(new Uint8Array(0))).toBe('other')
  })

  it.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'msf1'])('an iPhone photo: brand %s → heic', (brand) => {
    expect(sniffImage(ftyp(brand, 'mif1'))).toBe('heic')
  })

  it('AVIF, by its own brand or listed among mif1’s compatible brands', () => {
    expect(sniffImage(ftyp('avif', 'mif1'))).toBe('avif')
    expect(sniffImage(ftyp('avis'))).toBe('avif')
    expect(sniffImage(ftyp('mif1', 'miaf', 'avif'))).toBe('avif')
    expect(sniffImage(ftyp('mif1', 'heic'))).toBe('heic')
    expect(sniffImage(ftyp('mif1'))).toBe('heic')
  })

  it('a video in an ISO-BMFF box is no image', () => {
    expect(sniffImage(ftyp('isom', 'mp41'))).toBe('other')
  })
})

describe('the encoding ladder and base64', () => {
  it('only ever goes down in size and quality', () => {
    for (let i = 1; i < ENCODE_LADDER.length; i++) {
      const [a, b] = [ENCODE_LADDER[i - 1], ENCODE_LADDER[i]]
      expect(b.scale <= a.scale && (b.scale < a.scale || b.quality < a.quality)).toBe(true)
      expect(b.scale * b.scale * b.quality).toBeLessThan(a.scale * a.scale * a.quality)
    }
    expect(ENCODE_LADDER[0]).toEqual({ scale: 1, quality: 0.85 })
    expect(SCAN_TARGET_BASE64).toBeLessThan(1_600_000)
  })

  it('reads the base64 after the first comma, and its size in characters', () => {
    expect(base64OfDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe('/9j/4AAQ')
    expect(base64Size('/9j/4AAQ')).toBe(8)
  })
})
