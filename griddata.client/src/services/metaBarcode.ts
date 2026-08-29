// Metadata barcode — a B&W strip filling the top BARCODE_ROWS rows of the grid.
//
// The receiver reads this FIRST to learn the sender's encoding, EXACT grid
// height, code rate, and zone config — replacing the expensive auto-detect
// search that tried every (enc, gridW, gridH, rate) combination with full LDPC
// decodes. Reading a B&W strip + CRC-8 check is near-instantaneous.
//
// Encoding gridH here is what makes RECTANGULAR grids work: the receiver finds
// gridW by trying candidate widths, but gridH derived from pixel geometry can be
// off by a row or two — enough that lower data rows drift out of alignment and
// never decode even though row 0 (the barcode) still reads. The exact gridH from
// the barcode removes that guesswork. gridH is always a multiple of 8 (the sender
// rounds it), so 6 bits of gridH/8 cover up to 504 rows.
//
// Fixed metadata pattern (32 bars, each BAR_CELLS cells wide):
//   [sync : 4 bars = 1101]
//   [version : 2 bars]
//   [enc  : 3 bars] — index into ENC_ORDER
//   [rate : 3 bars] — index into RATE_MAP
//   [zones: 1 bar ] — adaptive spatial coding enabled
//   [gridH: 6 bars] — gridH / 8
//   [aux  : 6 bars] — gridW / 8, or ring width when zones=1
//   [CRC-7: 7 bars] — over the 21 data bars
// The strip is BARCODE_ROWS cells tall so the receiver can average rows for SNR.

import type { Encoding } from './visualCodec'

export const BARCODE_ROWS = 3
/** Rows 0-1 carry identical, full-contrast metadata copies. */
export const METADATA_BARCODE_ROWS = 2
/** Row 2 carries a changing timing word (fps/tick/lane). */
export const TIMING_BARCODE_ROW = 2
export const BARCODE_VERSION = 2

const ENC_ORDER: Encoding[] = ['color64', 'color32', 'color16', 'color8', 'bw']
// Keep existing indices stable for previously generated v3 matrices. The final
// 3-bit slot is the measured midpoint between 0.60 and 0.65.
const RATE_MAP = [0.5, 0.6, 0.65, 0.675, 0.7, 0.75, 0.9, 0.625]
// Sync: a short, low-frequency run (NOT the old 1010… which is the highest
// spatial frequency — any camera blur averages alternating single cells to flat
// gray and destroys it). Kept short so the whole pattern fits gridW≥60 cells.
const SYNC = [1, 1, 0, 1]
const DATA_BITS = 21 // version(2) + enc(3) + rate(3) + zones(1) + gridH(6) + aux(6)
const CRC_BITS = 7
const PATTERN_LEN = SYNC.length + DATA_BITS + CRC_BITS // exactly 32 bars
// Each pattern BAR spans this many grid cells. A 1-cell feature is narrower than
// the camera's blur kernel and cannot be recovered; 2-cell bars survive mild
// blur (a "11" bar's centre stays bright, a "00" bar's centre stays dark). The
// decoder groups cells back into bars by averaging, so encoder/decoder must
// agree on this constant.
export const BAR_CELLS = 2

export interface BarcodeData {
  version: number
  enc: Encoding
  rate: number
  zones: boolean
  ringWidth: number
  gridW: number
  gridH: number
  /** Static display layout; bit-packed into unused grid-width metadata space. */
  lanes?: 1 | 2
}

export interface TimingBarcodeData {
  /** Sender display cadence, represented in half-fps steps. */
  fps: number
  /** Logical sender tick, modulo 1024 on the wire. */
  tick: number
  /** Optical tile within one atomic Turbo exposure. */
  lane: 0 | 1
}

export function rateToIdx(rate: number): number {
  let best = 0, bestD = Math.abs(RATE_MAP[0] - rate)
  for (let i = 1; i < RATE_MAP.length; i++) {
    const d = Math.abs(RATE_MAP[i] - rate)
    if (d < bestD) { best = i; bestD = d }
  }
  return best
}

export function idxToRate(idx: number): number {
  return RATE_MAP[idx & 7] ?? 0.6
}

function encToIdx(enc: Encoding): number {
  const i = ENC_ORDER.indexOf(enc)
  return i >= 0 ? i : 3
}

function idxToEnc(idx: number): Encoding {
  return ENC_ORDER[idx] ?? 'color8'
}

function crc7(bits: number[], count: number): number {
  let crc = 0
  for (let i = 0; i < count; i++) {
    const fb = ((crc >> 6) & 1) ^ (bits[i] & 1)
    crc = (crc << 1) & 0x7F
    if (fb) crc ^= 0x09
  }
  return crc
}

function intToBits(val: number, count: number): number[] {
  const out: number[] = []
  for (let i = count - 1; i >= 0; i--) out.push((val >> i) & 1)
  return out
}

function bitsToInt(bits: number[], offset: number, count: number): number {
  let v = 0
  for (let i = 0; i < count; i++) v = (v << 1) | (bits[offset + i] & 1)
  return v
}

function buildPattern(data: BarcodeData): number[] {
  // Non-zoned widths currently fit in 5 bits (max 256 / 8 = 32). Reuse the
  // sixth bit for the visual lane count, so a receiver can switch to Turbo ×2
  // before it has decoded any manifest frame.
  const widthRaw = Math.min(32, Math.round(data.gridW / 8))
  const width = widthRaw === 32 ? 0 : widthRaw
  const aux = data.zones ? data.ringWidth : width | (data.lanes === 2 ? 0x20 : 0)
  const dataBits = [
    ...intToBits(data.version ?? BARCODE_VERSION, 2),
    ...intToBits(encToIdx(data.enc), 3),
    ...intToBits(rateToIdx(data.rate), 3),
    data.zones ? 1 : 0,
    ...intToBits(Math.min(63, Math.round(data.gridH / 8)), 6),
    ...intToBits(Math.min(63, aux), 6),
  ]
  const crc = crc7(dataBits, DATA_BITS)
  return [...SYNC, ...dataBits, ...intToBits(crc, CRC_BITS)]
}

/** Smallest grid width that can carry one full barcode copy. */
export const MIN_BARCODE_WIDTH = PATTERN_LEN * BAR_CELLS // 64

/** Encode one barcode row as RGB bytes (gridW cells). Each pattern bar spans
 *  BAR_CELLS cells so it survives camera blur. The caller paints this same row
 *  into all BARCODE_ROWS top rows. */
export function encodeBarcodeRow(data: BarcodeData, gridW: number): Uint8Array {
  const pattern = buildPattern(data)
  const out = new Uint8Array(gridW * 3)
  for (let i = 0; i < gridW; i++) {
    const bar = Math.floor(i / BAR_CELLS)
    const bit = pattern[bar % PATTERN_LEN]
    const v = bit ? 255 : 0
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v
  }
  return out
}

// Timing word uses the same proven 32-bar envelope and CRC-7 as metadata:
//   sync(4) + timing-version(2) + fps×2(8) + tick(10) + lane(1) + CRC-7.
// Its row retains bounded contrast (32/223). Legacy receivers that average
// all three top rows still see the two full-contrast metadata rows as a clean
// majority, while the wider timing separation survives camera blur/exposure well
// enough to reject duplicate ticks before the expensive full-grid LDPC pass.
const TIMING_VERSION = 1
export function encodeTimingBarcodeRow(data: TimingBarcodeData, gridW: number): Uint8Array {
  const fpsHalf = Math.max(0, Math.min(255, Math.round(data.fps * 2)))
  const dataBits = [
    ...intToBits(TIMING_VERSION, 2),
    ...intToBits(fpsHalf, 8),
    ...intToBits(data.tick & 0x3FF, 10),
    data.lane & 1,
  ]
  const pattern = [...SYNC, ...dataBits, ...intToBits(crc7(dataBits, DATA_BITS), CRC_BITS)]
  const out = new Uint8Array(gridW * 3)
  for (let i = 0; i < gridW; i++) {
    const bit = pattern[Math.floor(i / BAR_CELLS) % PATTERN_LEN]
    const v = bit ? 223 : 32
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v
  }
  return out
}


function decodeFromBits(bits: number[], off: number): BarcodeData {
  const d = bits.slice(off + SYNC.length, off + SYNC.length + DATA_BITS)
  const zones = !!d[8]
  const aux = bitsToInt(d, 15, 6)
  const lanes = zones ? 1 : (aux & 0x20 ? 2 : 1)
  return {
    version: bitsToInt(d, 0, 2),
    enc: idxToEnc(bitsToInt(d, 2, 3)),
    rate: idxToRate(bitsToInt(d, 5, 3)),
    zones,
    ringWidth: zones ? aux : 0,
    gridW: zones ? 0 : ((aux & 0x1F) || 32) * 8,
    gridH: bitsToInt(d, 9, 6) * 8,
    ...(lanes === 2 ? { lanes: 2 as const } : {}),
  }
}

/** Try to decode a barcode from B&W luminance samples of row 0.
 *  Returns null if the sync pattern or CRC doesn't match. Cells are grouped back
 *  into BAR_CELLS-wide bars (averaged) before thresholding, so mild blur that
 *  smears individual cells is tolerated. */
export function decodeBarcodeRow(lum: Float32Array, cellCount: number): BarcodeData | null {
  if (cellCount < MIN_BARCODE_WIDTH) return null

  // Try each sub-bar cell phase so a ±1 cell registration drift can't misgroup
  // the bars. Phase p groups cells [p, p+BAR), [p+BAR, p+2·BAR), …
  for (let phase = 0; phase < BAR_CELLS; phase++) {
    const barCount = Math.floor((cellCount - phase) / BAR_CELLS)
    if (barCount < PATTERN_LEN) continue
    // Average each bar's cells → one luminance per bar.
    const barLum = new Float32Array(barCount)
    for (let k = 0; k < barCount; k++) {
      let s = 0
      for (let j = 0; j < BAR_CELLS; j++) s += lum[phase + k * BAR_CELLS + j]
      barLum[k] = s / BAR_CELLS
    }
    // Threshold at the LARGEST GAP in the sorted bar values, not the median: the
    // barcode's 0/1 counts are unbalanced (sync+data+crc), so a median lands on
    // the majority level and misclassifies. The widest gap sits between the dark
    // and bright clusters regardless of their relative counts.
    const sorted = Float32Array.from(barLum).sort()
    let mid = (sorted[0] + sorted[barCount - 1]) / 2, bestGap = -1
    for (let k = 1; k < barCount; k++) {
      const gap = sorted[k] - sorted[k - 1]
      if (gap > bestGap) { bestGap = gap; mid = (sorted[k] + sorted[k - 1]) / 2 }
    }
    const bits: number[] = []
    for (let k = 0; k < barCount; k++) bits.push(barLum[k] > mid ? 1 : 0)

    // Locate the sync run (allow small alignment slack), CRC-check, then vote
    // across any repeated copies.
    for (let off = 0; off <= Math.min(4, barCount - PATTERN_LEN); off++) {
      let syncOk = true
      for (let i = 0; i < SYNC.length; i++) if (bits[off + i] !== SYNC[i]) { syncOk = false; break }
      if (!syncOk) continue

      const dataBits = bits.slice(off + SYNC.length, off + SYNC.length + DATA_BITS)
      const crcBits = bits.slice(off + SYNC.length + DATA_BITS, off + SYNC.length + DATA_BITS + CRC_BITS)
      if (crc7(dataBits, DATA_BITS) !== bitsToInt(crcBits, 0, CRC_BITS)) continue

      // Majority voting across repeated copies for extra robustness.
      if (barCount >= off + PATTERN_LEN * 2) {
        const votes = new Int32Array(PATTERN_LEN)
        for (let c = off; c + PATTERN_LEN <= barCount; c += PATTERN_LEN)
          for (let i = 0; i < PATTERN_LEN; i++) votes[i] += bits[c + i] ? 1 : -1
        const voted: number[] = []
        for (let i = 0; i < PATTERN_LEN; i++) voted.push(votes[i] > 0 ? 1 : 0)
        const vData = voted.slice(SYNC.length, SYNC.length + DATA_BITS)
        if (crc7(vData, DATA_BITS) === bitsToInt(voted, SYNC.length + DATA_BITS, CRC_BITS))
          return decodeFromBits(voted, 0)
      }
      return decodeFromBits(bits, off)
    }
  }
  return null
}

/** Decode the dedicated timing row. CRC rejection makes this safe to probe before
 * the expensive full-grid colour sample and LDPC pass. */
export function decodeTimingBarcodeRow(lum: Float32Array, cellCount: number): TimingBarcodeData | null {
  if (cellCount < MIN_BARCODE_WIDTH) return null
  for (let phase = 0; phase < BAR_CELLS; phase++) {
    const barCount = Math.floor((cellCount - phase) / BAR_CELLS)
    if (barCount < PATTERN_LEN) continue
    const barLum = new Float32Array(barCount)
    for (let k = 0; k < barCount; k++) {
      let sum = 0
      for (let j = 0; j < BAR_CELLS; j++) sum += lum[phase + k * BAR_CELLS + j]
      barLum[k] = sum / BAR_CELLS
    }
    const sorted = Float32Array.from(barLum).sort()
    let threshold = (sorted[0] + sorted[barCount - 1]) / 2, bestGap = -1
    for (let k = 1; k < barCount; k++) {
      const gap = sorted[k] - sorted[k - 1]
      if (gap > bestGap) { bestGap = gap; threshold = (sorted[k] + sorted[k - 1]) / 2 }
    }
    const bits = Array.from(barLum, v => v > threshold ? 1 : 0)
    for (let off = 0; off <= Math.min(4, barCount - PATTERN_LEN); off++) {
      let syncOk = true
      for (let i = 0; i < SYNC.length; i++) if (bits[off + i] !== SYNC[i]) { syncOk = false; break }
      if (!syncOk) continue
      const dataBits = bits.slice(off + SYNC.length, off + SYNC.length + DATA_BITS)
      const crc = bitsToInt(bits, off + SYNC.length + DATA_BITS, CRC_BITS)
      if (crc7(dataBits, DATA_BITS) !== crc || bitsToInt(dataBits, 0, 2) !== TIMING_VERSION) continue
      return {
        fps: bitsToInt(dataBits, 2, 8) / 2,
        tick: bitsToInt(dataBits, 10, 10),
        lane: bitsToInt(dataBits, 20, 1) as 0 | 1,
      }
    }
  }
  return null
}
