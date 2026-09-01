// Visual codec: bytes ⇄ coloured cell grid, and the optical SOFT demodulator.
//
// Encodings (direct, no transform spreading):
//   bw       1 bit / cell   (black / white)          — fastest, needs clean reads
//   color8   3 bits / cell  (R,G,B each on/off)      — robust workhorse
//   color16  4 bits / cell  (R×2, G×4, B×2 levels)
//   color32  5 bits / cell  (R×4, G×4, B×2 levels)
//   color64  6 bits / cell  (R×4, G×4, B×4 levels)   — densest
//
// The receiver never takes a hard per-cell decision here. `softDemodLLR` emits a
// per-bit log-likelihood ratio that (a) un-mixes the display→camera colour
// cross-talk with a blind 3×3 MIMO estimate learned from calibration anchors,
// and (b) is SCALED by each cell's optical reliability (how in-focus / unsaturated
// that cell was). Those LLRs feed the LDPC belief-propagation decoder directly —
// the whole point of dropping Reed-Solomon and Hadamard was to keep this soft
// information instead of throwing it away at a threshold.

import { BARCODE_ROWS } from './metaBarcode'

export type Encoding = 'bw' | 'color8' | 'color16' | 'color32' | 'color64'

export interface EncodingSpec {
  enc: Encoding
  gridW: number // cells across (columns)
  gridH: number // cells down (rows)
  rate?: number // LDPC code rate (message/codeword). Higher = more payload, weaker
                // correction. Default 0.6; speed profiles raise it on clean channels.
}

/** Total cell count for a spec. */
export function gridCells(s: EncodingSpec): number { return s.gridW * s.gridH }

/** LDPC code rate for a spec (message bytes ÷ codeword bytes). */
export const DEFAULT_RATE = 0.6
export function specRate(s: EncodingSpec): number { return s.rate ?? DEFAULT_RATE }

export interface CellReadings {
  r: Float32Array
  g: Float32Array
  b: Float32Array
  lum: Float32Array
  /** Per-cell optical reliability in [0,1] (1 = crisp, 0 = blurred/saturated). */
  rel?: Float32Array
}

// ── bit packing ──
export function bytesToBits(data: Uint8Array): Uint8Array {
  const bits = new Uint8Array(data.length * 8)
  for (let i = 0; i < data.length; i++)
    for (let b = 7; b >= 0; b--) bits[i * 8 + (7 - b)] = (data[i] >> b) & 1
  return bits
}

export function bitsToBytes(bits: Uint8Array): Uint8Array {
  const data = new Uint8Array(Math.ceil(bits.length / 8))
  for (let i = 0; i < bits.length; i++)
    if (bits[i] === 1) data[Math.floor(i / 8)] |= 1 << (7 - (i % 8))
  return data
}

// ── Gray coding of the multi-level colour constellation ──
// Adjacent PHYSICAL levels (the ones the camera confuses) map to data words that
// differ by exactly one bit, so the dominant "read level ℓ as ℓ±1" error costs
// one bit, not two. Encode: data word d → physical level grayToBinary(d).
function binaryToGray(x: number): number { return x ^ (x >> 1) }
function grayToBinary(g: number): number { let b = 0; for (; g; g >>= 1) b ^= g; return b }

/** Bits carried per R,G,B channel for each encoding (null = single-level bw). */
export function colorChannelBits(enc: Encoding): [number, number, number] | null {
  switch (enc) {
    case 'color8': return [1, 1, 1]
    case 'color16': return [1, 2, 1]
    case 'color32': return [2, 2, 1]
    case 'color64': return [2, 2, 2]
    default: return null
  }
}

// ── Calibration anchors ──
// The first `count` cells of every colour frame display KNOWN colours. The
// receiver reads them to learn the display→camera colour transform per frame.
// They do double duty:
//   • single-channel level anchors  → per-channel level centres (residual gamma),
//   • black + single-channel MAX anchors → the 3×3 MIMO mixing matrix + offset
//     (channel cross-talk), see estimateMimo.
export interface ColorAnchor { pos: number; c: number; level: number; r: number; g: number; b: number }
/** A complete transmitted colour word used as a camera-local Color16 pilot. */
export interface ColorSymbolAnchor { pos: number; word: number; r: number; g: number; b: number }
export interface ColorCalibration {
  count: number
  anchors: ColorAnchor[]
  symbols: ColorSymbolAnchor[]
  maxLevel: [number, number, number]
  cb: [number, number, number]
}

// A single pilot cell is vulnerable to one reflected pixel, Bayer artefact, or
// a slightly soft sample.  Repeating each known level costs only 16 extra cells
// on Color16 64×64, but turns the calibration into a small robust average.
const COLOR_PILOT_REPEATS = 3
// Two instances of all 16 Color16 words cost <1% of a 64x64 transfer, but give
// the receiver the actual display/camera constellation instead of assuming the
// three channels can be thresholded independently.
const COLOR_CODEBOOK_REPEATS = 2

// ── Perceptual (ambient-aware) level placement ──
// The display emits light ∝ digital^γ, and room light + screen glare add a small
// constant in the LINEAR light domain. Both crush the DARK levels together
// (their emitted-light gap shrinks toward zero), and camera shot noise — which
// enters in that same linear domain — then confuses them. Spacing the levels so
// the EMITTED LIGHT (+ambient) is evenly spread pulls the dark levels apart.
// Endpoints are preserved (level 0 → digital 0, top level → digital 255), so this
// is a pure redistribution of the intermediate levels; the receiver relearns the
// centres from the anchors automatically, so encoder and demod stay consistent.
//
// Closed form: choose digital d(level) so the assumed observed value
//   pix = ((d^γ + a)/(1+a))^(1/γ)
// is evenly spaced. Camera-agnostic (uses only display γ + a mild ambient guess);
// measured ~50% BER reduction for color16/32/64 and robust to the real camera γ
// (2.0–2.4) and ambient (0–0.06). Tune LEVEL_GAMMA / LEVEL_AMBIENT per deployment.
export const LEVEL_GAMMA = 2.2    // display EOTF exponent
export const LEVEL_AMBIENT = 0.03 // assumed ambient light as a fraction of white

/** Map a channel level (0..maxLevel) to a display byte 0..255 with ambient-aware spacing. */
export function levelToByte(level: number, maxLevel: number): number {
  if (maxLevel <= 0) return 0
  const g = LEVEL_GAMMA, a = LEVEL_AMBIENT
  const pix0 = Math.pow(a / (1 + a), 1 / g)           // observed value of level 0
  const pix = pix0 + (1 - pix0) * (level / maxLevel)  // evenly spaced observed
  const light = Math.max(0, Math.pow(pix, g) * (1 + a) - a)
  const d = Math.pow(light, 1 / g)                    // invert display EOTF
  return Math.round(Math.min(1, Math.max(0, d)) * 255)
}

export function colorCalibration(enc: Encoding): ColorCalibration | null {
  const cb = colorChannelBits(enc)
  if (!cb || enc === 'color8') return null // color8 is 2-level/channel, thresholded (no anchors)
  const maxLevel: [number, number, number] = [(1 << cb[0]) - 1, (1 << cb[1]) - 1, (1 << cb[2]) - 1]
  const anchors: ColorAnchor[] = []
  const symbols: ColorSymbolAnchor[] = []
  let pos = 0
  for (let c = 0; c < 3; c++) {
    const L = maxLevel[c] + 1
    if (L <= 1) continue
    for (let l = 0; l < L; l++) {
      for (let repeat = 0; repeat < COLOR_PILOT_REPEATS; repeat++) {
        const rgb = [0, 0, 0]
        rgb[c] = levelToByte(l, maxLevel[c])
        anchors.push({ pos, c, level: l, r: rgb[0], g: rgb[1], b: rgb[2] })
        pos++
      }
    }
  }
  if (enc === 'color16') {
    for (let rw = 0; rw < 2; rw++) for (let gw = 0; gw < 4; gw++) for (let bw = 0; bw < 2; bw++) {
      const word = (rw << 3) | (gw << 1) | bw
      for (let repeat = 0; repeat < COLOR_CODEBOOK_REPEATS; repeat++) {
        symbols.push({
          pos, word,
          r: levelToByte(grayToBinary(rw), maxLevel[0]),
          g: levelToByte(grayToBinary(gw), maxLevel[1]),
          b: levelToByte(grayToBinary(bw), maxLevel[2]),
        })
        pos++
      }
    }
  }
  return { count: pos, anchors, symbols, maxLevel, cb }
}

// ── capacity (row 0 reserved for barcode strip) ──
export function capacityBits(s: EncodingSpec): number {
  const n = gridCells(s) - s.gridW * BARCODE_ROWS
  const cb = colorChannelBits(s.enc)
  if (!cb) return n // bw
  if (s.enc === 'color8') return n * 3
  const cal = colorCalibration(s.enc)!
  return (n - cal.count) * (cb[0] + cb[1] + cb[2])
}
export function capacityBytes(s: EncodingSpec): number { return Math.floor(capacityBits(s) / 8) }

/**
 * v11 Color8 divides the payload area into four independently protected
 * quadrants.  A local glare/blur patch can then erase at most one codeword
 * instead of invalidating the whole matrix.  Capacities are derived entirely
 * from geometry, so no extra optical metadata is required.
 */
export function segmentedColor8Capacities(s: EncodingSpec): readonly number[] {
  if (s.enc !== 'color8') return []
  const dataRows = Math.max(0, s.gridH - BARCODE_ROWS)
  const left = Math.ceil(s.gridW / 2), right = Math.floor(s.gridW / 2)
  const top = Math.ceil(dataRows / 2), bottom = Math.floor(dataRows / 2)
  return [left * top, right * top, left * bottom, right * bottom]
    .map(cells => Math.floor(cells * 3 / 8))
}

function color8SegmentForCell(x: number, y: number, s: EncodingSpec): number {
  const dataY = y - BARCODE_ROWS
  const topRows = Math.ceil((s.gridH - BARCODE_ROWS) / 2)
  return (dataY < topRows ? 0 : 2) + (x < Math.ceil(s.gridW / 2) ? 0 : 1)
}

/** Encode four concatenated, independently-whitened codewords into quadrants. */
export function encodeCellsRGBSegmented(payload: Uint8Array, s: EncodingSpec): Uint8Array {
  if (s.enc !== 'color8') return encodeCellsRGB(payload, s)
  const caps = segmentedColor8Capacities(s)
  const offsets = [0, caps[0], caps[0] + caps[1], caps[0] + caps[1] + caps[2]]
  const bits = caps.map((cap, i) => bytesToBits(payload.subarray(offsets[i], offsets[i] + cap)))
  const cursors = [0, 0, 0, 0]
  const out = new Uint8Array(gridCells(s) * 3)
  for (let y = BARCODE_ROWS; y < s.gridH; y++) for (let x = 0; x < s.gridW; x++) {
    const segment = color8SegmentForCell(x, y, s)
    const cursor = cursors[segment]
    const cell = (y * s.gridW + x) * 3
    out[cell] = bits[segment][cursor] ? 255 : 0
    out[cell + 1] = bits[segment][cursor + 1] ? 255 : 0
    out[cell + 2] = bits[segment][cursor + 2] ? 255 : 0
    cursors[segment] += 3
  }
  return out
}

/** Split the ordinary row-major Color8 LLR stream back into four quadrants. */
export function splitColor8SegmentLlrs(llr: Float32Array, s: EncodingSpec): Float32Array[] {
  const caps = segmentedColor8Capacities(s)
  if (caps.length !== 4) return [Float32Array.from(llr)]
  const out = caps.map(cap => new Float32Array(cap * 8))
  const cursors = [0, 0, 0, 0]
  for (let y = BARCODE_ROWS; y < s.gridH; y++) for (let x = 0; x < s.gridW; x++) {
    const segment = color8SegmentForCell(x, y, s)
    const src = ((y - BARCODE_ROWS) * s.gridW + x) * 3
    const dst = cursors[segment]
    for (let channel = 0; channel < 3 && dst + channel < out[segment].length; channel++)
      out[segment][dst + channel] = llr[src + channel]
    cursors[segment] += 3
  }
  return out
}

// ── encode: payload bytes → per-cell RGB (0..255 ×3) for the display ──
// Row 0 is left black (reserved for the barcode strip — caller overlays it).
export function encodeCellsRGB(payload: Uint8Array, s: EncodingSpec): Uint8Array {
  const n = gridCells(s)
  const bc = s.gridW * BARCODE_ROWS
  const out = new Uint8Array(n * 3)
  const bits = bytesToBits(payload)

  if (s.enc === 'bw') {
    for (let i = bc; i < n; i++) { const v = (bits[i - bc] ?? 0) ? 255 : 0; out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v }
    return out
  }
  if (s.enc === 'color8') {
    for (let i = bc; i < n; i++) {
      const b = (i - bc) * 3
      out[i * 3] = (bits[b] ?? 0) ? 255 : 0
      out[i * 3 + 1] = (bits[b + 1] ?? 0) ? 255 : 0
      out[i * 3 + 2] = (bits[b + 2] ?? 0) ? 255 : 0
    }
    return out
  }
  // Multi-level colour with leading calibration anchors (placed after barcode row).
  const cal = colorCalibration(s.enc)!
  const cb = cal.cb, max = cal.maxLevel
  for (const a of cal.anchors) { out[(bc + a.pos) * 3] = a.r; out[(bc + a.pos) * 3 + 1] = a.g; out[(bc + a.pos) * 3 + 2] = a.b }
  for (const a of cal.symbols) { out[(bc + a.pos) * 3] = a.r; out[(bc + a.pos) * 3 + 1] = a.g; out[(bc + a.pos) * 3 + 2] = a.b }
  let o = 0
  for (let i = bc + cal.count; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      let word = 0
      for (let j = 0; j < cb[c]; j++) word = (word << 1) | (bits[o++] ?? 0)
      const level = max[c] > 0 ? grayToBinary(word) : 0
      out[i * 3 + c] = levelToByte(level, max[c])
    }
  }
  return out
}

// ── 3×3 colour MIMO estimate ──
// Model: observed = A · emitted + off, where emitted ∈ [0,1]³ (per channel,
// normalised) and A captures channel cross-talk (R light bleeding into the G/B
// sensor buckets, white-balance gain, etc.). We solve A and off directly from
// anchors: the black anchor gives off; each single-channel MAX anchor gives one
// column of A. Returns the INVERSE (un-mix) matrix + offset, or null if the
// anchors are too degenerate to invert (caller falls back to per-channel k-means).
interface Mimo { inv: number[]; off: [number, number, number] }
interface ColorCodeword { word: number; r: number; g: number; b: number }
interface LevelCalibrationCache {
  uses: number
  mimo: Mimo | null
  centers: number[][]
  codebook: ColorCodeword[] | null
}
// The display/camera colour transform changes slowly compared with frame rate.
// Reusing a recent calibration avoids repeating anchor fitting and k-means for
// every color16/32/64 frame; each worker refreshes it frequently enough to track
// normal auto-exposure changes.
const levelCalibrationCache = new Map<string, LevelCalibrationCache>()
const LEVEL_CALIBRATION_REFRESH = 8
const _distScratch = new Float64Array(8)
const _symbolDistScratch = new Float64Array(16)
function estimateMimo(cal: ColorCalibration, chan: [Float32Array, Float32Array, Float32Array], posOffset = 0): Mimo | null {
  // Offset = mean observed over all level-0 (black) anchors.
  const off: [number, number, number] = [0, 0, 0]
  let blacks = 0
  for (const a of cal.anchors) if (a.level === 0) { const p = a.pos + posOffset; off[0] += chan[0][p]; off[1] += chan[1][p]; off[2] += chan[2][p]; blacks++ }
  if (blacks === 0) return null
  off[0] /= blacks; off[1] /= blacks; off[2] /= blacks
  // Columns of A from the mean of each channel's MAX-level pilots (emitted = 1
  // on that channel).  A single anchor is too easily perturbed on mobile video.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0] // row-major 3×3
  for (let c = 0; c < 3; c++) {
    if (cal.maxLevel[c] === 0) return null
    let count = 0, r = 0, g = 0, b = 0
    for (const a of cal.anchors) if (a.c === c && a.level === cal.maxLevel[c]) {
      const ap = a.pos + posOffset
      r += chan[0][ap]; g += chan[1][ap]; b += chan[2][ap]; count++
    }
    if (count === 0) return null
    A[0 * 3 + c] = r / count - off[0]
    A[1 * 3 + c] = g / count - off[1]
    A[2 * 3 + c] = b / count - off[2]
  }
  const inv = invert3(A)
  return inv ? { inv, off } : null
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-6) return null
  const id = 1 / det
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ]
}
function applyMimo(m: Mimo, r: number, g: number, b: number): [number, number, number] {
  const x = r - m.off[0], y = g - m.off[1], z = b - m.off[2]
  return [
    m.inv[0] * x + m.inv[1] * y + m.inv[2] * z,
    m.inv[3] * x + m.inv[4] * y + m.inv[5] * z,
    m.inv[6] * x + m.inv[7] * y + m.inv[8] * z,
  ]
}

/** Learn the full Color16 palette from the screen/camera pair after MIMO un-mixing.
 * Keeping one centroid per complete RGB word captures non-linear residuals that
 * separate per-channel thresholds cannot see. */
function learnColor16Codebook(cal: ColorCalibration, um: [Float32Array, Float32Array, Float32Array], posOffset: number): ColorCodeword[] | null {
  if (cal.symbols.length < 16) return null
  const sum = Array.from({ length: 16 }, () => [0, 0, 0])
  const count = new Int32Array(16)
  for (const s of cal.symbols) {
    const p = s.pos + posOffset, q = sum[s.word]
    q[0] += um[0][p]; q[1] += um[1][p]; q[2] += um[2][p]
    count[s.word]++
  }
  const out: ColorCodeword[] = []
  for (let word = 0; word < 16; word++) {
    if (!count[word]) return null
    out.push({ word, r: sum[word][0] / count[word], g: sum[word][1] / count[word], b: sum[word][2] / count[word] })
  }
  // Reject a collapsed palette and fall back to the old soft per-channel path.
  let minD2 = Infinity
  for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
    const dr = out[a].r - out[b].r, dg = out[a].g - out[b].g, db = out[a].b - out[b].b
    minD2 = Math.min(minD2, dr * dr + dg * dg + db * db)
  }
  return minD2 > 1e-5 ? out : null
}

/**
 * Soft-decision demodulation → per-frame-bit LLR (LLR > 0 favours bit 0), in the
 * exact bit order the encoder consumed, so `bytesToBits(frame)` lines up index
 * for index. Each cell's LLRs are scaled by its optical reliability rd.rel[i].
 * Length = capacityBytes*8.
 */
export interface SoftDemodOptions {
  mimo?: boolean        // apply the 3×3 colour cross-talk un-mixing (default true)
  reliability?: boolean // scale LLRs by per-cell optical reliability (default true)
}

// ── Blind spatial equalisation ─────────────────────────────────────────────
// A dense display→camera link behaves like a small low-pass filter: each sampled
// cell contains a little of its four neighbours.  The transmitted LDPC word is
// whitened/interleaved, so its adjacent cells are statistically independent;
// positive neighbour correlation in a received frame is therefore a direct,
// calibration-free blur estimate.  We use that estimate to apply a *regularised*
// inverse filter.  It is deliberately bounded: a noisy but sharp frame must not
// be sharpened into false confidence.
//
// This is useful for BW 128×128 and Color8 alike.  It only runs after geometry is
// locked, never touches the static barcode strip, and simply returns the original
// readings when the channel is already crisp.
let _eq0: Float32Array | null = null, _eq1: Float32Array | null = null
let _eq2: Float32Array | null = null, _eqLum: Float32Array | null = null
let _eqTmp: Float32Array | null = null
// Deconvolution iterations. The old fixed unsharp is exactly ONE Van Cittert step;
// a few more invert heavier blur that a single step under-corrects (sim-proven:
// σ=0.72 single-frame recovery 0%→98% vs the 1-step version). Gated + range-clamped,
// so a crisp frame is untouched and noise can't be amplified into false confidence.
const DECONV_ITERS = 3
function eqTmp(n: number): Float32Array {
  if (!_eqTmp || _eqTmp.length < n) _eqTmp = new Float32Array(n)
  return _eqTmp
}
interface SpatialSimdBackend {
  unsharp(src: Float32Array, dst: Float32Array, w: number, h: number, from: number, strength: number, lo: number, hi: number): void
  deconvolve(src: Float32Array, dst: Float32Array, w: number, h: number, from: number, spill: number, lo: number, hi: number, iters: number): void
}
let spatialSimd: SpatialSimdBackend | null = null

/** Installed by the decode worker after WebAssembly-SIMD feature detection. */
export function setSpatialSimd(backend: SpatialSimdBackend | null): void { spatialSimd = backend }

export interface SpatialEqualizerOptions {
  /**
   * Stable, receiver-estimated blur gain.  When omitted the function uses the
   * instantaneous estimate, which is useful in tests and one-off decodes.
   */
  strength?: number
}

function eqScratch(slot: 0 | 1 | 2 | 3, n: number): Float32Array {
  let a = slot === 0 ? _eq0 : slot === 1 ? _eq1 : slot === 2 ? _eq2 : _eqLum
  if (!a || a.length < n) {
    a = new Float32Array(n)
    if (slot === 0) _eq0 = a
    else if (slot === 1) _eq1 = a
    else if (slot === 2) _eq2 = a
    else _eqLum = a
  }
  return a
}

function neighbourCorrelation(v: Float32Array, gridW: number, gridH: number, from: number): number {
  let sum = 0, sum2 = 0, count = 0
  for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
    const i = y * gridW + x
    if (i < from) continue
    const z = v[i]
    sum += z; sum2 += z * z; count++
  }
  if (count < 16) return 0
  const mean = sum / count
  const variance = sum2 / count - mean * mean
  if (!(variance > 16)) return 0
  let cov = 0, pairs = 0
  for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
    const i = y * gridW + x
    if (i < from) continue
    const d = v[i] - mean
    if (x + 1 < gridW && i + 1 >= from) { cov += d * (v[i + 1] - mean); pairs++ }
    if (y + 1 < gridH && i + gridW >= from) { cov += d * (v[i + gridW] - mean); pairs++ }
  }
  return pairs ? cov / pairs / variance : 0
}

function sharpenChannel(src: Float32Array, dst: Float32Array, tmp: Float32Array, gridW: number, gridH: number, from: number, strength: number, iters: number): void {
  let lo = Infinity, hi = -Infinity
  for (let i = from; i < src.length; i++) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v }
  // Leave the barcode/pilot prefix exact; clipping a little beyond the observed
  // range preserves real black/white extremes while preventing ringing.
  const pad = Math.max(4, (hi - lo) * 0.08)
  const loC = lo - pad, hiC = hi + pad
  // The WASM backend now keeps the observation plus every Van Cittert iteration
  // in one SIMD call. Browsers without SIMD continue through the identical scalar
  // expression below.
  const sp = Math.min(0.49, strength * 1.6)
  // Crossing into WASM copies one input and one output array. That overhead is
  // a win for dense grids (notably BW 128×128), while the small 64×64 Color8
  // grid is faster in the allocation-free scalar loop. Larger colour grids
  // still take this SIMD path per channel.
  if (spatialSimd && src.length >= 8192) {
    spatialSimd.deconvolve(src, dst, gridW, gridH, from, sp, loC, hiC, iters)
    return
  }
  // Van Cittert deconvolution against an estimated symmetric box blur B (spill sp):
  //   X̂₀ = Y (observed);  X̂_{t+1} = clamp( X̂_t + (Y − B·X̂_t) ).
  // `strength` is the estimated unsharp gain; map it to the blur spill it inverts.
  // One iteration reduces to the old unsharp; more steps invert heavier smear.
  const len = src.length
  for (let i = 0; i < len; i++) dst[i] = src[i]
  for (let t = 0; t < iters; t++) {
    for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
      const i = y * gridW + x
      if (i < from || x === 0 || x + 1 === gridW || y === 0 || y + 1 === gridH) { tmp[i] = dst[i]; continue }
      const nb = (dst[i - 1] + dst[i + 1] + dst[i - gridW] + dst[i + gridW]) * 0.25
      tmp[i] = (1 - sp) * dst[i] + sp * nb // B·X̂
    }
    for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
      const i = y * gridW + x
      if (i < from || x === 0 || x + 1 === gridW || y === 0 || y + 1 === gridH) continue
      const q = dst[i] + (src[i] - tmp[i]) // X̂ + residual
      dst[i] = q < loC ? loC : q > hiC ? hiC : q
    }
  }
}

/** Return blur-compensated readings. Runs for every encoding — the multi-level
 *  colour modes (color16/32/64) are exactly where blur merges adjacent levels, so
 *  deblurring the RGB channels before their level classification is what makes them
 *  usable; the calibration anchors are deblurred too (they read closer to the true
 *  levels afterwards). Binary modes keep the luminance/RGB path they had. */
/**
 * Estimate the optical spill/MTF loss from the high-frequency payload itself.
 * Interleaving and whitening make neighbouring transmitted symbols independent,
 * so positive adjacent correlation is caused by the screen→lens point-spread
 * function rather than by the data.  A worker smooths this value over time
 * before passing it to `equalizeSpatialReadings`, giving a device-specific MTF
 * estimate without a setup screen or a hard-coded phone profile.
 */
export function estimateSpatialBlur(rd: CellReadings, s: EncodingSpec): number {
  const from = s.gridW * BARCODE_ROWS
  const rho = s.enc === 'bw'
    ? neighbourCorrelation(rd.lum, s.gridW, s.gridH, from)
    : (neighbourCorrelation(rd.r, s.gridW, s.gridH, from) + neighbourCorrelation(rd.g, s.gridW, s.gridH, from) + neighbourCorrelation(rd.b, s.gridW, s.gridH, from)) / 3
  // Random/whitened symbols produce rho≈0.  Above ~0.08, blur is measurable.
  // The cap (0.34) is the regularisation that makes this safe under glare/noise.
  return Math.max(0, Math.min(0.34, (rho - 0.08) * 0.82))
}

export function equalizeSpatialReadings(rd: CellReadings, s: EncodingSpec, opts?: SpatialEqualizerOptions): CellReadings {
  const n = gridCells(s), from = s.gridW * BARCODE_ROWS
  const strength = opts?.strength == null ? estimateSpatialBlur(rd, s) : Math.max(0, Math.min(0.34, opts.strength))
  if (strength < 0.025) return rd
  // Heavier measured blur → more deconvolution steps (a light smear needs only one).
  const iters = strength > 0.18 ? DECONV_ITERS : strength > 0.09 ? 2 : 1
  const tmp = eqTmp(n)
  const lum = eqScratch(3, n)
  sharpenChannel(rd.lum, lum, tmp, s.gridW, s.gridH, from, strength, iters)
  if (s.enc === 'bw') return { r: rd.r, g: rd.g, b: rd.b, lum, rel: rd.rel }
  const r = eqScratch(0, n), g = eqScratch(1, n), b = eqScratch(2, n)
  sharpenChannel(rd.r, r, tmp, s.gridW, s.gridH, from, strength, iters)
  sharpenChannel(rd.g, g, tmp, s.gridW, s.gridH, from, strength, iters)
  sharpenChannel(rd.b, b, tmp, s.gridW, s.gridH, from, strength, iters)
  return { r, g, b, lum, rel: rd.rel }
}

// Per-worker scratch buffers, reused across frames so the hot decode path doesn't
// allocate (and GC) ~1.3 MB every frame — the churn that spikes per-frame time on
// phones. Each Web Worker is its own module instance, so these are private to it and
// never shared across the pool. Grown on demand; the fill loops overwrite the whole
// [0,len) range every call, so no clearing is needed.
let _scratchOut: Float32Array | null = null
let _scratchUm0: Float32Array | null = null, _scratchUm1: Float32Array | null = null, _scratchUm2: Float32Array | null = null
function scratchOut(nBits: number): Float32Array {
  if (!_scratchOut || _scratchOut.length < nBits) _scratchOut = new Float32Array(nBits)
  return _scratchOut
}

export function softDemodLLR(rd: CellReadings, s: EncodingSpec, opts?: SoftDemodOptions): Float32Array {
  const useMimo = opts?.mimo !== false
  const useRel = opts?.reliability !== false
  const n = gridCells(s)
  const bc = s.gridW * BARCODE_ROWS
  const nBits = capacityBytes(s) * 8
  const rel = rd.rel
  const relOf = (i: number) => (useRel && rel ? rel[i] : 1)

  // bw / color8: 2-level per channel via an adaptive threshold (skip barcode row).
  if (s.enc === 'bw' || s.enc === 'color8') {
    const out = scratchOut(nBits)
    const softCh = (v: Float32Array, put: (di: number, llr: number) => void) => {
      let mn = Infinity, mx = -Infinity
      for (let i = bc; i < n; i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i] }
      const mid = (mn + mx) / 2, scale = 8 / Math.max(1, mx - mn)
      for (let i = bc; i < n; i++) {
        let l = (mid - v[i]) * scale * relOf(i)
        if (l > 20) l = 20; else if (l < -20) l = -20
        put(i - bc, l)
      }
    }
    if (s.enc === 'bw' && s.gridW > 64) {
      // Dense photographed BW is not uniformly lit: screen viewing angle,
      // vignetting and glare shift the black/white midpoint across the tile.
      // A single global min/max threshold leaves ~30% grey ambiguous cells in
      // real 96² captures. Learn two luminance clusters independently in small
      // spatial tiles; whitening guarantees both symbols occur in each region.
      const tile = 16
      for (let y0 = BARCODE_ROWS; y0 < s.gridH; y0 += tile) {
        const y1 = Math.min(s.gridH, y0 + tile)
        for (let x0 = 0; x0 < s.gridW; x0 += tile) {
          const x1 = Math.min(s.gridW, x0 + tile)
          let dark = Infinity, light = -Infinity
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const v = rd.lum[y * s.gridW + x]
            if (v < dark) dark = v
            if (v > light) light = v
          }
          // Four Lloyd iterations are enough for a 1-D, well-separated binary
          // constellation and cost far less than one LDPC attempt.
          for (let it = 0; it < 4; it++) {
            const mid = (dark + light) * 0.5
            let sd = 0, sl = 0, nd = 0, nl = 0
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
              const v = rd.lum[y * s.gridW + x]
              if (v < mid) { sd += v; nd++ } else { sl += v; nl++ }
            }
            if (nd) dark = sd / nd
            if (nl) light = sl / nl
          }
          const mid = (dark + light) * 0.5
          const scale = 10 / Math.max(8, light - dark)
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = y * s.gridW + x, o = i - bc
            if (o >= nBits) continue
            let l = (mid - rd.lum[i]) * scale * relOf(i)
            if (l > 20) l = 20; else if (l < -20) l = -20
            out[o] = l
          }
        }
      }
    } else if (s.enc === 'bw') softCh(rd.lum, (di, l) => { if (di < nBits) out[di] = l })
    else {
      softCh(rd.r, (di, l) => { const o = di * 3; if (o < nBits) out[o] = l })
      softCh(rd.g, (di, l) => { const o = di * 3 + 1; if (o < nBits) out[o] = l })
      softCh(rd.b, (di, l) => { const o = di * 3 + 2; if (o < nBits) out[o] = l })
    }
    return out.subarray(0, nBits)
  }

  // Multi-level colour: un-mix cross-talk (MIMO), then per-channel soft levels.
  const cal = colorCalibration(s.enc)!
  const cb = cal.cb
  const chan: [Float32Array, Float32Array, Float32Array] = [rd.r, rd.g, rd.b]
  const cacheKey = `${s.enc}:${s.gridW}x${s.gridH}:${useMimo ? 1 : 0}`
  const cached = levelCalibrationCache.get(cacheKey)
  const refreshCalibration = !cached || cached.uses >= LEVEL_CALIBRATION_REFRESH
  const mimo = useMimo ? (refreshCalibration ? estimateMimo(cal, chan, bc) : cached!.mimo) : null

  // Un-mixed working values for every cell (skip barcode row; falls back to raw
  // channels if MIMO couldn't be estimated). Reused scratch + inlined MIMO so we
  // don't allocate three n-arrays AND a 3-tuple per cell (65k tuples/frame) each time.
  if (!_scratchUm0 || _scratchUm0.length < n) { _scratchUm0 = new Float32Array(n); _scratchUm1 = new Float32Array(n); _scratchUm2 = new Float32Array(n) }
  const um: [Float32Array, Float32Array, Float32Array] = [_scratchUm0, _scratchUm1!, _scratchUm2!]
  if (mimo) {
    const iv = mimo.inv, of0 = mimo.off[0], of1 = mimo.off[1], of2 = mimo.off[2]
    for (let i = bc; i < n; i++) {
      const x = rd.r[i] - of0, y = rd.g[i] - of1, z = rd.b[i] - of2
      um[0][i] = iv[0] * x + iv[1] * y + iv[2] * z
      um[1][i] = iv[3] * x + iv[4] * y + iv[5] * z
      um[2][i] = iv[6] * x + iv[7] * y + iv[8] * z
    }
  } else {
    for (let i = bc; i < n; i++) { um[0][i] = rd.r[i]; um[1][i] = rd.g[i]; um[2][i] = rd.b[i] }
  }

  // Per-channel level centres, learned from the (un-mixed) anchors; k-means fallback.
  // Color16 additionally learns the whole 3-D codebook from its palette pilots.
  let centers: number[][]
  let codebook: ColorCodeword[] | null
  if (!refreshCalibration && cached) {
    centers = cached.centers
    codebook = cached.codebook
    cached.uses++
  } else {
    centers = [[], [], []]
    const sums = [[], [], []] as number[][]
    const counts = [[], [], []] as number[][]
    for (const a of cal.anchors) {
      sums[a.c][a.level] = (sums[a.c][a.level] ?? 0) + um[a.c][a.pos + bc]
      counts[a.c][a.level] = (counts[a.c][a.level] ?? 0) + 1
    }
    for (let c = 0; c < 3; c++) for (let level = 0; level < (1 << cb[c]); level++)
      centers[c][level] = (counts[c][level] ?? 0) > 0 ? sums[c][level]! / counts[c][level]! : 0
    for (let c = 0; c < 3; c++) {
      const L = 1 << cb[c]
      if (L === 1) continue
      let ok = centers[c].length === L
      for (let k = 1; k < L && ok; k++) if (!(centers[c][k] - centers[c][k - 1] > 1e-3)) ok = false
      if (!ok) centers[c] = kmeans1d(um[c], n, L, bc)
    }
    codebook = s.enc === 'color16' ? learnColor16Codebook(cal, um, bc) : null
    levelCalibrationCache.set(cacheKey, { uses: 1, mimo, centers, codebook })
  }

  const per = cb[0] + cb[1] + cb[2]
  const dataStart = bc + cal.count
  const dataN = n - dataStart
  const out = scratchOut(nBits)
  if (s.enc === 'color16' && codebook) {
    // Maximum-likelihood 3-D decision: every LLR compares the nearest complete
    // colour whose bit is 0 with the nearest whose bit is 1. This is the local
    // camera palette, not an ideal RGB cube, so residual gamma/cross-talk are
    // naturally included in the decision.
    let minSep2 = Infinity
    for (let a = 0; a < codebook.length; a++) for (let b = a + 1; b < codebook.length; b++) {
      const dr = codebook[a].r - codebook[b].r, dg = codebook[a].g - codebook[b].g, db = codebook[a].b - codebook[b].b
      minSep2 = Math.min(minSep2, dr * dr + dg * dg + db * db)
    }
    const scale = 7 / Math.max(1e-5, minSep2)
    for (let d = 0; d < dataN; d++) {
      const p = dataStart + d, vr = um[0][p], vg = um[1][p], vb = um[2][p]
      const dist = _symbolDistScratch
      for (let k = 0; k < codebook.length; k++) {
        const q = codebook[k], dr = vr - q.r, dg = vg - q.g, db = vb - q.b
        dist[k] = dr * dr + dg * dg + db * db
      }
      for (let bit = 0; bit < 4; bit++) {
        const shift = 3 - bit
        let d0 = Infinity, d1 = Infinity
        for (let k = 0; k < codebook.length; k++) {
          const dd = dist[k]
          if ((codebook[k].word >> shift) & 1) { if (dd < d1) d1 = dd } else if (dd < d0) d0 = dd
        }
        let llr = (d1 - d0) * scale * relOf(p)
        if (llr > 40) llr = 40; else if (llr < -40) llr = -40
        const o = d * 4 + bit
        if (o < nBits) out[o] = llr
      }
    }
    return out.subarray(0, nBits)
  }
  for (let c = 0; c < 3; c++) {
    const L = 1 << cb[c]
    if (L === 1) continue
    const ctr = centers[c]
    let gap = 0
    for (let k = 1; k < L; k++) gap += Math.abs(ctr[k] - ctr[k - 1])
    gap = Math.max(1e-3, gap / (L - 1))
    const sigma = gap * 0.35
    const scale = 1 / (2 * sigma * sigma)
    const chanOffset = c === 0 ? 0 : c === 1 ? cb[0] : cb[0] + cb[1]
    // Gray word per physical level is constant for the channel — hoist it out of the
    // per-cell loop instead of recomputing binaryToGray() for every bit of every cell.
    const gray = new Int32Array(L)
    for (let level = 0; level < L; level++) gray[level] = binaryToGray(level)
    const cbc = cb[c]
    for (let d = 0; d < dataN; d++) {
      const cellRel = relOf(dataStart + d)
      const v = um[c][dataStart + d]
      // Compute the L squared distances ONCE per cell (the hot inner cost), then let
      // each bit just min over the levels — previously (v-ctr)² was recomputed for
      // every bit, doubling the multiplies on the densest colour modes.
      for (let level = 0; level < L; level++) { const x = v - ctr[level]; _distScratch[level] = x * x }
      for (let t = 0; t < cbc; t++) {
        const wbit = cbc - 1 - t
        let d0 = Infinity, d1 = Infinity
        for (let level = 0; level < L; level++) {
          const dd = _distScratch[level]
          if ((gray[level] >> wbit) & 1) { if (dd < d1) d1 = dd } else { if (dd < d0) d0 = dd }
        }
        const o = d * per + chanOffset + t
        if (o < nBits) {
          let llr = (d1 - d0) * scale * cellRel
          if (llr > 40) llr = 40; else if (llr < -40) llr = -40
          out[o] = llr
        }
      }
    }
  }
  return out.subarray(0, nBits)
}

// ══════════════════════════════════════════════════════════════════════════════
// Zone-aware encoding / decoding
// ══════════════════════════════════════════════════════════════════════════════
// When adaptive spatial coding is active, each cell uses its zone's encoding.
// Calibration anchors use the densest encoding and are placed at cell 0..cal-1.
// The LDPC codeword / interleaving operates on the flat bitstream; these
// functions translate between that bitstream and the variable-bits-per-cell grid.

import { type ZoneMap, cellZoneEnc, bitsPerCellEnc, isMultiZone } from './adaptiveZones'
export type { ZoneMap }

/** Data capacity in bits for a zone map (excludes barcode row and calibration anchors). */
export function capacityBitsZoned(zm: ZoneMap): number {
  const n = zm.gridW * zm.gridH
  const bc = zm.gridW * BARCODE_ROWS
  const densest = zm.zones[0]?.enc ?? 'color8'
  const cal = colorCalibration(densest)
  const anchorCount = cal?.count ?? 0
  let total = 0
  for (let i = bc + anchorCount; i < n; i++) total += bitsPerCellEnc(cellZoneEnc(zm, i - bc))
  return total
}
export function capacityBytesZoned(zm: ZoneMap): number {
  return Math.floor(capacityBitsZoned(zm) / 8)
}

/**
 * Encode payload bits into per-cell RGB using zone-aware variable encoding.
 * Calibration anchors for the densest zone are placed at the first cells.
 */
export function encodeCellsRGBZoned(payload: Uint8Array, zm: ZoneMap): Uint8Array {
  if (!isMultiZone(zm)) return encodeCellsRGB(payload, { enc: zm.zones[0].enc, gridW: zm.gridW, gridH: zm.gridH })
  const { gridW, gridH } = zm
  const n = gridW * gridH
  const bc = gridW * BARCODE_ROWS
  const out = new Uint8Array(n * 3)
  const bits = bytesToBits(payload)

  const densest = zm.zones[0].enc
  const cal = colorCalibration(densest)
  const anchorCount = cal?.count ?? 0
  if (cal) {
    for (const a of cal.anchors) { out[(bc + a.pos) * 3] = a.r; out[(bc + a.pos) * 3 + 1] = a.g; out[(bc + a.pos) * 3 + 2] = a.b }
    for (const a of cal.symbols) { out[(bc + a.pos) * 3] = a.r; out[(bc + a.pos) * 3 + 1] = a.g; out[(bc + a.pos) * 3 + 2] = a.b }
  }

  let bo = 0
  for (let i = bc + anchorCount; i < n; i++) {
    const enc = cellZoneEnc(zm, i - bc)
    if (enc === 'bw') {
      const v = (bits[bo] ?? 0) ? 255 : 0
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v
      bo++
    } else if (enc === 'color8') {
      out[i * 3]     = (bits[bo]     ?? 0) ? 255 : 0
      out[i * 3 + 1] = (bits[bo + 1] ?? 0) ? 255 : 0
      out[i * 3 + 2] = (bits[bo + 2] ?? 0) ? 255 : 0
      bo += 3
    } else {
      const cb = colorChannelBits(enc)!
      const ml: [number, number, number] = [(1 << cb[0]) - 1, (1 << cb[1]) - 1, (1 << cb[2]) - 1]
      for (let c = 0; c < 3; c++) {
        let word = 0
        for (let j = 0; j < cb[c]; j++) word = (word << 1) | (bits[bo++] ?? 0)
        out[i * 3 + c] = levelToByte(ml[c] > 0 ? grayToBinary(word) : 0, ml[c])
      }
    }
  }
  return out
}

/**
 * Zone-aware soft demodulation → per-data-bit LLR, in the same bit order as
 * encodeCellsRGBZoned consumed them. The MIMO matrix is estimated from the
 * densest zone's calibration anchors (the display→camera colour transform is
 * global); per-channel level centres for each encoding are derived from k-means
 * over that encoding's cells.
 */
export function softDemodLLRZoned(
  rd: CellReadings, zm: ZoneMap, opts?: SoftDemodOptions
): Float32Array {
  if (!isMultiZone(zm)) return softDemodLLR(rd, { enc: zm.zones[0].enc, gridW: zm.gridW, gridH: zm.gridH }, opts)
  const useMimo = opts?.mimo !== false
  const useRel  = opts?.reliability !== false
  const { gridW, gridH } = zm
  const n = gridW * gridH
  const bc = gridW * BARCODE_ROWS
  const rel = rd.rel
  const relOf = (i: number) => (useRel && rel ? rel[i] : 1)

  const nBits = capacityBytesZoned(zm) * 8
  const out = new Float32Array(nBits)

  const densest = zm.zones[0].enc
  const cal = colorCalibration(densest)
  const anchorCount = cal?.count ?? 0
  const chan: [Float32Array, Float32Array, Float32Array] = [rd.r, rd.g, rd.b]
  const mimo = (useMimo && cal) ? estimateMimo(cal, chan, bc) : null

  // Un-mix ALL cells (skip barcode row 0)
  const um: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = bc; i < n; i++) {
    if (mimo) { const [er, eg, eb] = applyMimo(mimo, rd.r[i], rd.g[i], rd.b[i]); um[0][i] = er; um[1][i] = eg; um[2][i] = eb }
    else { um[0][i] = rd.r[i]; um[1][i] = rd.g[i]; um[2][i] = rd.b[i] }
  }

  // Global thresholds for bw (luminance) and color8 (per-channel) — skip barcode row
  let lumMn = Infinity, lumMx = -Infinity
  for (let i = bc; i < n; i++) { if (rd.lum[i] < lumMn) lumMn = rd.lum[i]; if (rd.lum[i] > lumMx) lumMx = rd.lum[i] }
  const lumMid = (lumMn + lumMx) / 2, lumSc = 8 / Math.max(1, lumMx - lumMn)
  const chMid = [0, 0, 0], chSc = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    let mn = Infinity, mx = -Infinity
    for (let i = bc; i < n; i++) { if (chan[c][i] < mn) mn = chan[c][i]; if (chan[c][i] > mx) mx = chan[c][i] }
    chMid[c] = (mn + mx) / 2; chSc[c] = 8 / Math.max(1, mx - mn)
  }

  // Per-encoding level centres for multi-level zones via k-means
  const mlCenters = new Map<Encoding, number[][]>()
  const encCellSets = new Map<Encoding, number[]>()
  for (let i = bc + anchorCount; i < n; i++) {
    const enc = cellZoneEnc(zm, i - bc)
    if (enc !== 'bw' && enc !== 'color8') {
      let arr = encCellSets.get(enc)
      if (!arr) { arr = []; encCellSets.set(enc, arr) }
      arr.push(i)
    }
  }
  for (const [enc, cells] of encCellSets) {
    const cb = colorChannelBits(enc)!
    const cen: number[][] = [[], [], []]
    if (cal && enc === densest) for (const a of cal.anchors) cen[a.c][a.level] = um[a.c][bc + a.pos]
    for (let c = 0; c < 3; c++) {
      const L = 1 << cb[c]
      if (L <= 1) continue
      let ok = cen[c].length === L
      for (let k = 1; k < L && ok; k++) if (!(cen[c][k] - cen[c][k - 1] > 1e-3)) ok = false
      if (!ok) {
        const vals = new Float32Array(cells.length)
        for (let j = 0; j < cells.length; j++) vals[j] = um[c][cells[j]]
        cen[c] = kmeans1d(vals, vals.length, L)
      }
    }
    mlCenters.set(enc, cen)
  }

  // Produce LLRs per data cell
  let bo = 0
  for (let i = bc + anchorCount; i < n; i++) {
    const enc = cellZoneEnc(zm, i - bc)
    const cr = relOf(i)
    if (enc === 'bw') {
      let l = (lumMid - rd.lum[i]) * lumSc * cr
      if (l > 20) l = 20; else if (l < -20) l = -20
      if (bo < nBits) out[bo] = l
      bo++
    } else if (enc === 'color8') {
      for (let c = 0; c < 3; c++) {
        let l = (chMid[c] - chan[c][i]) * chSc[c] * cr
        if (l > 20) l = 20; else if (l < -20) l = -20
        if (bo < nBits) out[bo] = l
        bo++
      }
    } else {
      const cb = colorChannelBits(enc)!
      const cen = mlCenters.get(enc)!
      for (let c = 0; c < 3; c++) {
        const L = 1 << cb[c]
        if (L <= 1) continue
        const ctr = cen[c]
        let gap = 0
        for (let k = 1; k < L; k++) gap += Math.abs(ctr[k] - ctr[k - 1])
        gap = Math.max(1e-3, gap / (L - 1))
        const sigma = gap * 0.35, scale = 1 / (2 * sigma * sigma)
        const v = um[c][i]
        for (let t = 0; t < cb[c]; t++) {
          const wbit = cb[c] - 1 - t
          let d0 = Infinity, d1 = Infinity
          for (let level = 0; level < L; level++) {
            const word = binaryToGray(level)
            const dist = v - ctr[level], dd = dist * dist
            if ((word >> wbit) & 1) { if (dd < d1) d1 = dd } else { if (dd < d0) d0 = dd }
          }
          if (bo < nBits) {
            let llr = (d1 - d0) * scale * cr
            if (llr > 40) llr = 40; else if (llr < -40) llr = -40
            out[bo] = llr
          }
          bo++
        }
      }
    }
  }
  return out
}

/**
 * 1-D k-means over the first `n` samples of `v` into `L` clusters. Centres are
 * seeded evenly across the observed range and returned ascending, so a sample's
 * nearest-centre index is directly its quantised level. Invariant to any
 * monotonic gain/offset the camera applies — the k-means fallback for when the
 * anchors themselves come back unusable.
 */
function kmeans1d(v: ArrayLike<number>, n: number, L: number, startIdx = 0): number[] {
  let mn = Infinity, mx = -Infinity
  for (let i = startIdx; i < n; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x }
  if (mx - mn < 1e-6) return Array.from({ length: L }, () => mn)
  const cen = Array.from({ length: L }, (_, k) => mn + (mx - mn) * k / (L - 1))
  const sum = new Float64Array(L), cnt = new Int32Array(L)
  for (let it = 0; it < 12; it++) {
    sum.fill(0); cnt.fill(0)
    for (let i = startIdx; i < n; i++) {
      const x = v[i]
      let bk = 0, bd = Infinity
      for (let k = 0; k < L; k++) { const d = Math.abs(x - cen[k]); if (d < bd) { bd = d; bk = k } }
      sum[bk] += x; cnt[bk]++
    }
    for (let k = 0; k < L; k++) if (cnt[k]) cen[k] = sum[k] / cnt[k]
    cen.sort((a, b) => a - b)
  }
  return cen
}
