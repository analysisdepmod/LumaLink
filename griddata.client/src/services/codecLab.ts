import { FountainDecoder } from './fountainDecoder'
import { packFrameLdpc, parseFrameLdpcSoft, seedForDataIndex } from './transferCodec'
import { BARCODE_ROWS } from './metaBarcode'
import { capacityBytes, encodeCellsRGB, equalizeSpatialReadings, softDemodLLR, type CellReadings, type EncodingSpec } from './visualCodec'
import { ldpcDecodeJs, ldpcEncodeParity, makeLdpcKM, type LdpcCode } from './ldpc'

export interface LabCase {
  k: number
  successRate: number
  trials: number
  seed: number
}

export interface LabResult {
  scheme: string
  averageFrames: number
  p90Frames: number
  worstFrames: number
}

class Mulberry32 {
  private state: number
  constructor(seed: number) { this.state = seed >>> 0 }
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1) >>> 0
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function summarize(scheme: string, samples: number[]): LabResult {
  const ordered = [...samples].sort((a, b) => a - b)
  return {
    scheme,
    averageFrames: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    p90Frames: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.9))]!,
    worstFrames: ordered[ordered.length - 1]!,
  }
}

/** Current systematic-fountain schedule, with an IID optical-frame loss model. */
export function simulateFountain(input: LabCase, directPerRepair = 5, mediumWideEvery = 4): LabResult {
  const samples: number[] = []
  const maxFrames = input.k * 8
  for (let trial = 0; trial < input.trials; trial++) {
    const decoder = new FountainDecoder(input.k, 1, true, mediumWideEvery)
    const random = new Mulberry32(input.seed + trial * 7919)
    let sent = 0
    while (!decoder.isComplete && sent < maxFrames) {
      if (random.next() < input.successRate) decoder.addFrame(seedForDataIndex(sent, input.k, directPerRepair), new Uint8Array(1))
      sent++
    }
    samples.push(sent)
  }
  return summarize(`systematic-fountain-${directPerRepair}+1/w${mediumWideEvery}`, samples)
}

/**
 * Ideal MDS block code (the best-case model for Reed-Solomon): a block completes
 * after any K received shards. This is intentionally an optimistic benchmark;
 * a real browser RS implementation can only be slower, never faster.
 */
export function simulateIdealBlockMds(input: LabCase, blockSize: number, parity: number): LabResult {
  const samples: number[] = []
  const maxFrames = input.k * 8
  for (let trial = 0; trial < input.trials; trial++) {
    const random = new Mulberry32(input.seed + trial * 7919)
    const blockLengths: number[] = []
    for (let offset = 0; offset < input.k; offset += blockSize) blockLengths.push(Math.min(blockSize, input.k - offset))
    const received = new Array(blockLengths.length).fill(0)
    let sent = 0
    // Systematic shards followed by fixed parity per block.
    for (let block = 0; block < blockLengths.length; block++) {
      const sentForBlock = blockLengths[block]! + parity
      for (let shard = 0; shard < sentForBlock; shard++) {
        if (random.next() < input.successRate) received[block]++
        sent++
      }
    }
    // A one-way sender has no ACK, so it round-robins extra parity for every
    // block until all receivers would have enough shards.
    while (received.some((count, block) => count < blockLengths[block]) && sent < maxFrames) {
      for (let block = 0; block < blockLengths.length && sent < maxFrames; block++) {
        if (random.next() < input.successRate) received[block]++
        sent++
      }
    }
    samples.push(sent)
  }
  return summarize(`ideal-mds-${blockSize}+${parity}`, samples)
}

// ── Optical-channel measurement of the spatial (MTF) equalizer ──
// A faithful end-to-end frame loop through the ACTUAL system code — the same
// packFrameLdpc encoder, cell mapping, soft demod, equalizer, and LDPC/CRC decoder
// the browser runs — with a controlled blur+noise channel inserted where the
// display→camera optics live. It isolates ONE mechanism: does the equalizer recover
// whole frames that the identical pipeline drops when the equalizer is off?
//
// This is algorithmic potential under a modelled channel (paper methodology A), NOT
// device throughput. Reliability weighting is deliberately held at rel=1 so the
// figure reflects the neighbour-deconvolution alone, not the separate C1 mechanism.

/** One standard-normal sample (Box–Muller) from a Mulberry32 stream. */
function gaussian(rng: Mulberry32): number {
  const u = Math.max(1e-9, rng.next()), v = rng.next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Blur one rendered channel: every data cell leaks a `spill` fraction to its 4
 *  neighbours (a separable box PSF), then picks up Gaussian sensor noise. The
 *  barcode strip is left exact, matching the real finder/pilot region. */
function blurChannel(src: Float32Array, gridW: number, gridH: number, from: number, spill: number, noise: number, rng: Mulberry32): Float32Array {
  const out = new Float32Array(src.length)
  for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
    const i = y * gridW + x
    if (i < from) { out[i] = src[i]; continue }
    let sum = 0, w = 0
    if (x > 0) { sum += src[i - 1]; w++ }
    if (x + 1 < gridW) { sum += src[i + 1]; w++ }
    if (i - gridW >= from) { sum += src[i - gridW]; w++ }
    if (i + gridW < src.length) { sum += src[i + gridW]; w++ }
    const neighbour = w ? sum / w : src[i]
    out[i] = src[i] * (1 - spill) + neighbour * spill + gaussian(rng) * noise
  }
  return out
}

export interface EqualizerPoint {
  spill: number
  recoveredWithout: number
  recoveredWith: number
  trials: number
}

/**
 * Sweep blur strength and, at each level, measure the fraction of frames the
 * pipeline recovers with the spatial equalizer OFF vs ON.
 */
export function simulateEqualizerGain(
  spec: EncodingSpec,
  spills: number[],
  opts: { trials?: number; noise?: number; seed?: number } = {},
): EqualizerPoint[] {
  const trials = opts.trials ?? 40
  const noise = opts.noise ?? 10
  const baseSeed = opts.seed ?? 0x1234abcd
  const cap = capacityBytes(spec)
  const rate = spec.rate ?? 0.6
  const from = spec.gridW * BARCODE_ROWS
  const n = spec.gridW * spec.gridH
  const usable = Math.max(1, Math.floor(cap * rate) - 13) // payload bytes that fit
  const isColor = spec.enc === 'color8'

  return spills.map((spill) => {
    let recWithout = 0, recWith = 0
    for (let t = 0; t < trials; t++) {
      const rng = new Mulberry32(baseSeed + t * 2654435761 + Math.round(spill * 1e4) * 40503)
      const frameSeed = 1 + ((rng.next() * 0x7fffffff) | 0)
      const payload = new Uint8Array(usable)
      for (let i = 0; i < usable; i++) payload[i] = (rng.next() * 256) | 0
      const codeword = packFrameLdpc(1, frameSeed, payload, cap, rate)
      const rgb = encodeCellsRGB(codeword, spec)

      // Split the rendered grid into channels the demod expects.
      const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), lum = new Float32Array(n)
      for (let i = 0; i < n; i++) { r[i] = rgb[i * 3]; g[i] = rgb[i * 3 + 1]; b[i] = rgb[i * 3 + 2] }

      let readings: CellReadings
      if (isColor) {
        const rb = blurChannel(r, spec.gridW, spec.gridH, from, spill, noise, rng)
        const gb = blurChannel(g, spec.gridW, spec.gridH, from, spill, noise, rng)
        const bb = blurChannel(b, spec.gridW, spec.gridH, from, spill, noise, rng)
        for (let i = 0; i < n; i++) lum[i] = rb[i] * 0.299 + gb[i] * 0.587 + bb[i] * 0.114
        readings = { r: rb, g: gb, b: bb, lum, rel: new Float32Array(n).fill(1) }
      } else {
        for (let i = 0; i < n; i++) lum[i] = rgb[i * 3]
        const lb = blurChannel(lum, spec.gridW, spec.gridH, from, spill, noise, rng)
        readings = { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0), lum: lb, rel: new Float32Array(n).fill(1) }
      }

      const off = parseFrameLdpcSoft(softDemodLLR(readings, spec), cap, rate, false)
      const eq = equalizeSpatialReadings(readings, spec)
      const on = parseFrameLdpcSoft(softDemodLLR(eq, spec), cap, rate, false)
      if (off && off.seed === frameSeed) recWithout++
      if (on && on.seed === frameSeed) recWith++
    }
    return { spill, recoveredWithout: recWithout / trials, recoveredWith: recWith / trials, trials }
  })
}

// ── Multi-look spatial super-resolution (PROPOSED mechanism, sim proof) ──
// The temporal soft-combiner (C2) already collects several camera captures of the
// SAME displayed frame and sums their LLRs — but that only averages out NOISE; the
// blur (ISI between cells) is identical in every look, so it survives the sum. The
// insight: hand jitter shifts each capture by a sub-pixel amount, so the looks are
// not redundant — each sees the grid through a DIFFERENTLY-SHIFTED point-spread
// function. That shift diversity is new spatial information. Fusing N shifted
// blurred looks by multi-frame deconvolution recovers cell detail that no single
// look — and no amount of noise-averaging — can, breaking the single-capture blur
// cutoff behind the "binary-per-channel is the ceiling" finding.
//
// Honest scope: this is a PROPOSED mechanism proven in a modelled channel, not yet
// integrated. It assumes per-look sub-pixel offsets are recovered by registration
// (GridData already computes a per-frame homography; sub-pixel refinement is the
// missing piece). The baseline it is measured against is the CURRENT system's best:
// per-look spatial equalizer + C2 LLR chase-combining, on the identical looks.

/** 3×3 Gaussian sampling kernel centred at a sub-pixel shift (in cell units). */
function shiftKernel(dx: number, dy: number, sigma: number): Float64Array {
  const g = new Float64Array(9); let s = 0
  const inv = 1 / (2 * sigma * sigma)
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const w = Math.exp(-(((ox - dx) ** 2) + ((oy - dy) ** 2)) * inv)
    g[(oy + 1) * 3 + (ox + 1)] = w; s += w
  }
  for (let i = 0; i < 9; i++) g[i] /= s
  return g
}

/** Forward optical operator A: Y[i] = Σ g[o]·X[i+o] (shifted blur). Barcode exact. */
function applyBlurOp(X: Float32Array, W: number, H: number, from: number, g: Float64Array): Float32Array {
  const Y = new Float32Array(X.length)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (i < from) { Y[i] = X[i]; continue }
    let acc = 0
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy
      const j = (yy >= 0 && yy < H && xx >= 0 && xx < W) ? yy * W + xx : i
      acc += g[(oy + 1) * 3 + (ox + 1)] * X[j]
    }
    Y[i] = acc
  }
  return Y
}

/** Transpose operator Aᵀ: scatter each residual back through the same kernel. */
function applyBlurOpT(R: Float32Array, W: number, H: number, from: number, g: Float64Array): Float32Array {
  const O = new Float32Array(R.length)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (i < from) { O[i] += R[i]; continue }
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy
      const j = (yy >= 0 && yy < H && xx >= 0 && xx < W) ? yy * W + xx : i
      O[j] += g[(oy + 1) * 3 + (ox + 1)] * R[i]
    }
  }
  return O
}

/** Landweber multi-frame deconvolution: X̂ ← X̂ + μ·Σ_k Aᵀ_k(Y_k − A_k X̂). */
function superResolve(looks: { Y: Float32Array; g: Float64Array }[], W: number, H: number, from: number, iters: number, mu: number): Float32Array {
  const n = W * H, N = looks.length
  const X = new Float32Array(n)
  for (const l of looks) for (let i = 0; i < n; i++) X[i] += l.Y[i] / N // init = aligned average
  for (let it = 0; it < iters; it++) {
    const grad = new Float32Array(n)
    for (const l of looks) {
      const Yhat = applyBlurOp(X, W, H, from, l.g)
      const res = new Float32Array(n)
      for (let i = 0; i < n; i++) res[i] = l.Y[i] - Yhat[i]
      const bp = applyBlurOpT(res, W, H, from, l.g)
      for (let i = 0; i < n; i++) grad[i] += bp[i]
    }
    for (let i = 0; i < n; i++) X[i] += (mu / N) * grad[i]
  }
  return X
}

/** Bilinear sample of grid A at fractional (x,y), edge-clamped. */
function bilinearSample(A: Float32Array, W: number, H: number, x: number, y: number): number {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0
  const fx = x - x0, fy = y - y0
  const a = A[y0 * W + x0], b = A[y0 * W + x1], c = A[y1 * W + x0], d = A[y1 * W + x1]
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

/** Estimate the sub-pixel shift of `tgt` relative to `ref` (iterative Lucas-Kanade)
 *  from the reading grids themselves — no registration change needed. Returns
 *  [dx,dy] in cells: tgt ≈ ref sampled at (x+dx, y+dy). */
function estimateShift(ref: Float32Array, tgt: Float32Array, W: number, H: number, from: number): [number, number] {
  let dx = 0, dy = 0
  const y0 = Math.max(1, Math.ceil(from / W) + 1)
  for (let iter = 0; iter < 6; iter++) {
    let A = 0, B = 0, C = 0, D = 0, E = 0
    for (let y = y0; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const gx = (ref[i + 1] - ref[i - 1]) * 0.5
      const gy = (ref[i + W] - ref[i - W]) * 0.5
      const tw = bilinearSample(tgt, W, H, x + dx, y + dy)
      const dt = ref[i] - tw
      A += gx * gx; B += gx * gy; C += gy * gy; D += gx * dt; E += gy * dt
    }
    const det = A * C - B * B
    if (Math.abs(det) < 1e-6) break
    const ddx = (C * D - B * E) / det, ddy = (A * E - B * D) / det
    dx += ddx; dy += ddy
    if (Math.abs(ddx) + Math.abs(ddy) < 1e-3) break
  }
  return [dx, dy]
}

export interface SuperResPoint {
  looks: number
  recoveredBaseline: number // equalizer + C2 chase-combining
  recoveredSuperRes: number // multi-frame deconvolution
  trials: number
}

// ── Idea #4: joint 3-D colour VQ vs the current linear-MIMO + per-channel decode ──
// The current colour path un-mixes cross-talk with a linear 3×3 inverse, then reads
// each channel to its nearest level. That inverts LINEAR mixing perfectly — so a
// fair test of "joint 3-D vector-quantiser wins" must include the NON-LINEAR part
// (per-channel display/camera gamma applied AFTER the mix) that a linear inverse
// cannot undo. The VQ arm calibrates the 16 observed codeword points jointly in 3-D
// and classifies to the nearest one; the baseline gets the system's real advantage
// (known 3×3 inverse) but still decides each channel independently afterwards.
// Metric is symbol-error-rate — the demod quality this idea is actually about.
export interface ColorVQPoint {
  crosstalk: number
  serBaseline: number // linear MIMO un-mix + per-channel nearest level
  serVQ: number       // joint 3-D nearest observed codeword
  trials: number
}

/** Invert a 3×3 matrix (row-major 9-array); returns null if near-singular. */
function invert3(a: number[]): number[] | null {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a
  const c0 = a4 * a8 - a5 * a7, c1 = a5 * a6 - a3 * a8, c2 = a3 * a7 - a4 * a6
  const det = a0 * c0 + a1 * c1 + a2 * c2
  if (Math.abs(det) < 1e-6) return null
  const id = 1 / det
  return [
    c0 * id, (a2 * a7 - a1 * a8) * id, (a1 * a5 - a2 * a4) * id,
    c1 * id, (a0 * a8 - a2 * a6) * id, (a2 * a3 - a0 * a5) * id,
    c2 * id, (a1 * a6 - a0 * a7) * id, (a0 * a4 - a1 * a3) * id,
  ]
}
const mul3 = (m: number[], v: number[]): number[] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]

export function simulateColorVQ(
  crosstalks: number[],
  opts: { trials?: number; gamma?: number; noise?: number; seed?: number } = {},
): ColorVQPoint[] {
  const trials = opts.trials ?? 4000
  const gamma = opts.gamma ?? 2.2
  const noise = opts.noise ?? 10
  const baseSeed = opts.seed ?? 0xc010f
  // color16 structure: R∈2 levels, G∈4 (gamma-optimised), B∈2 levels → 16 codewords.
  const levels = [[0, 255], [0, 112, 185, 255], [0, 255]]
  const words: number[][] = []
  for (const r of levels[0]) for (const g of levels[1]) for (const b of levels[2]) words.push([r, g, b])

  return crosstalks.map((c) => {
    // Row-normalised cross-talk matrix (unit gain, off-diagonal leak = c).
    const g = 1 / (1 + 2 * c)
    const A = [g, c * g, c * g, c * g, g, c * g, c * g, c * g, g]
    const Ainv = invert3(A) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const chan = (disp: number[]): number[] => {
      const mixed = mul3(A, disp)                                  // linear cross-talk
      return mixed.map((m) => 255 * ((Math.max(0, m) / 255) ** gamma)) // then gamma
    }
    // Calibrate (noise-free) observed points: joint codeword centres for VQ, and
    // per-channel marginal level centres (after linear un-mix) for the baseline.
    const obsWord = words.map(chan)
    const unmixWord = obsWord.map((o) => mul3(Ainv, o))
    const perChanCentres = [new Map<number, { s: number; n: number }>(), new Map<number, { s: number; n: number }>(), new Map<number, { s: number; n: number }>()]
    words.forEach((w, wi) => {
      for (let ch = 0; ch < 3; ch++) {
        const key = w[ch]
        const acc = perChanCentres[ch].get(key) ?? { s: 0, n: 0 }
        acc.s += unmixWord[wi][ch]; acc.n++; perChanCentres[ch].set(key, acc)
      }
    })
    const levelCentre = perChanCentres.map((m, ch) => levels[ch].map((lv) => { const a = m.get(lv)!; return { lv, c: a.s / a.n } }))

    const rng = new Mulberry32(baseSeed + Math.round(c * 1e4))
    let errB = 0, errV = 0
    for (let t = 0; t < trials; t++) {
      const wi = (rng.next() * words.length) | 0
      const o = chan(words[wi]).map((v) => v + gaussian(rng) * noise)
      // Baseline: linear un-mix, then nearest per-channel level independently.
      const u = mul3(Ainv, o)
      const decCh = (ch: number) => { let best = 0, bd = Infinity; for (const { lv, c: cc } of levelCentre[ch]) { const d = (u[ch] - cc) ** 2; if (d < bd) { bd = d; best = lv } } return best }
      const bWord = [decCh(0), decCh(1), decCh(2)]
      if (bWord[0] !== words[wi][0] || bWord[1] !== words[wi][1] || bWord[2] !== words[wi][2]) errB++
      // VQ: nearest joint observed codeword in 3-D.
      let bestW = 0, bd = Infinity
      for (let k = 0; k < words.length; k++) { const dx = o[0] - obsWord[k][0], dy = o[1] - obsWord[k][1], dz = o[2] - obsWord[k][2]; const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; bestW = k } }
      if (bestW !== wi) errV++
    }
    return { crosstalk: c, serBaseline: errB / trials, serVQ: errV / trials, trials }
  })
}

// ── Idea #5a: does the current 1-D byte interleave already tolerate a 2-D burst? ──
// A localised glare patch corrupts a CONTIGUOUS square of cells. If frame recovery
// through the REAL 1-D-interleaved pipeline stays high until the patch is large,
// there is little headroom for a 2-D (PSF-matched) interleave to add — the decision
// this measures. Corrupted cells are set to a saturated "glare" value so the soft
// demod gives them near-zero confidence (an erasure), exactly like real glare.
export interface GlarePoint {
  patchCells: number
  patchFraction: number
  recovered: number
  trials: number
}

export function simulateGlareBurst(
  spec: EncodingSpec,
  patchSides: number[],
  opts: { trials?: number; seed?: number } = {},
): GlarePoint[] {
  const trials = opts.trials ?? 60
  const baseSeed = opts.seed ?? 0x91a5e
  const cap = capacityBytes(spec)
  const rate = spec.rate ?? 0.6
  const from = spec.gridW * BARCODE_ROWS
  const n = spec.gridW * spec.gridH
  const usable = Math.max(1, Math.floor(cap * rate) - 13)
  const relOne = new Float32Array(n).fill(1)
  const dataCells = n - from

  return patchSides.map((side) => {
    let rec = 0
    for (let t = 0; t < trials; t++) {
      const rng = new Mulberry32(baseSeed + t * 2654435761 + side * 40503)
      const frameSeed = 1 + ((rng.next() * 0x7fffffff) | 0)
      const payload = new Uint8Array(usable)
      for (let i = 0; i < usable; i++) payload[i] = (rng.next() * 256) | 0
      const rgb = encodeCellsRGB(packFrameLdpc(1, frameSeed, payload, cap, rate), spec)
      const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), lum = new Float32Array(n)
      for (let i = 0; i < n; i++) { r[i] = rgb[i * 3]; g[i] = rgb[i * 3 + 1]; b[i] = rgb[i * 3 + 2]; lum[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114 }
      // Drop a saturated square patch at a random location within the data region.
      const y0 = BARCODE_ROWS + Math.floor(rng.next() * Math.max(1, spec.gridH - BARCODE_ROWS - side))
      const x0 = Math.floor(rng.next() * Math.max(1, spec.gridW - side))
      for (let dy = 0; dy < side; dy++) for (let dx = 0; dx < side; dx++) {
        const i = (y0 + dy) * spec.gridW + (x0 + dx)
        if (i >= from && i < n) { r[i] = g[i] = b[i] = lum[i] = 200; relOne[i] = 1 }
      }
      const rd: CellReadings = spec.enc === 'bw'
        ? { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0), lum, rel: relOne }
        : { r, g, b, lum, rel: relOne }
      const f = parseFrameLdpcSoft(softDemodLLR(rd, spec), cap, rate, false)
      if (f && f.seed === frameSeed) rec++
    }
    return { patchCells: side * side, patchFraction: (side * side) / dataCells, recovered: rec / trials, trials }
  })
}

// ── Idea #3: multi-step deconvolution vs the production 1-step unsharp ──
// The production equalizer's unsharp step is provably ONE Landweber iteration of a
// deconvolution. This measures whether running the SAME inverse a few more steps
// recovers more frames (single look, so it's an apples-to-apples front-end swap).
export interface DeconvPoint {
  sigma: number
  recoveredRaw: number        // no equalization
  recoveredUnsharp: number    // production equalizeSpatialReadings (1 step)
  recoveredDeconv: number     // K-step Landweber single-frame deconvolution
  trials: number
}

export function simulateSingleFrameDeconv(
  spec: EncodingSpec,
  sigmas: number[],
  opts: { trials?: number; noise?: number; iters?: number; mu?: number; seed?: number } = {},
): DeconvPoint[] {
  const trials = opts.trials ?? 40
  const noise = opts.noise ?? 12
  const iters = opts.iters ?? 12
  const mu = opts.mu ?? 1.0
  const baseSeed = opts.seed ?? 0x0dec04
  const cap = capacityBytes(spec)
  const rate = spec.rate ?? 0.6
  const from = spec.gridW * BARCODE_ROWS
  const n = spec.gridW * spec.gridH
  const usable = Math.max(1, Math.floor(cap * rate) - 13)
  const relOne = new Float32Array(n).fill(1)

  return sigmas.map((sigma) => {
    const isColor = spec.enc !== 'bw'
    let raw = 0, uns = 0, dec = 0
    for (let t = 0; t < trials; t++) {
      const rng = new Mulberry32(baseSeed + t * 2654435761 + Math.round(sigma * 1e4) * 40503)
      const frameSeed = 1 + ((rng.next() * 0x7fffffff) | 0)
      const payload = new Uint8Array(usable)
      for (let i = 0; i < usable; i++) payload[i] = (rng.next() * 256) | 0
      const rgb = encodeCellsRGB(packFrameLdpc(1, frameSeed, payload, cap, rate), spec)
      const g = shiftKernel(0, 0, sigma) // zero-shift symmetric PSF
      const W = spec.gridW, H = spec.gridH

      const blurCh = (pick: number): { seen: Float32Array; sharp: Float32Array } => {
        const src = new Float32Array(n)
        for (let i = 0; i < n; i++) src[i] = rgb[i * 3 + pick]
        const seen = applyBlurOp(src, W, H, from, g)
        for (let i = from; i < n; i++) seen[i] += gaussian(rng) * noise
        return { seen, sharp: superResolve([{ Y: seen, g }], W, H, from, iters, mu) }
      }

      let rd: CellReadings, rdD: CellReadings
      if (isColor) {
        const R = blurCh(0), G = blurCh(1), B = blurCh(2)
        const lumS = new Float32Array(n), lumD = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          lumS[i] = R.seen[i] * 0.299 + G.seen[i] * 0.587 + B.seen[i] * 0.114
          lumD[i] = R.sharp[i] * 0.299 + G.sharp[i] * 0.587 + B.sharp[i] * 0.114
        }
        rd = { r: R.seen, g: G.seen, b: B.seen, lum: lumS, rel: relOne }
        rdD = { r: R.sharp, g: G.sharp, b: B.sharp, lum: lumD, rel: relOne }
      } else {
        const L = blurCh(0)
        rd = { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0), lum: L.seen, rel: relOne }
        rdD = { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0), lum: L.sharp, rel: relOne }
      }

      const rawF = parseFrameLdpcSoft(softDemodLLR(rd, spec), cap, rate, false)
      const unsF = parseFrameLdpcSoft(softDemodLLR(equalizeSpatialReadings(rd, spec), spec), cap, rate, false)
      const decF = parseFrameLdpcSoft(softDemodLLR(rdD, spec), cap, rate, false)
      if (rawF && rawF.seed === frameSeed) raw++
      if (unsF && unsF.seed === frameSeed) uns++
      if (decF && decF.seed === frameSeed) dec++
    }
    return { sigma, recoveredRaw: raw / trials, recoveredUnsharp: uns / trials, recoveredDeconv: dec / trials, trials }
  })
}

/**
 * At a fixed heavy blur (where a single look fails), measure frame recovery as a
 * function of the number of combined looks, for the current best baseline
 * (equalizer + C2) vs proposed multi-frame super-resolution.
 */
export function simulateSuperResolution(
  spec: EncodingSpec,
  lookCounts: number[],
  opts: { trials?: number; sigma?: number; jitter?: number; noise?: number; iters?: number; mu?: number; seed?: number; shiftError?: number; estimateShifts?: boolean } = {},
): SuperResPoint[] {
  const trials = opts.trials ?? 30
  const sigma = opts.sigma ?? 0.85   // PSF width in cells (>0.7 → real cross-cell ISI)
  const jitter = opts.jitter ?? 0.5  // sub-pixel shift range (cells)
  const noise = opts.noise ?? 14
  const iters = opts.iters ?? 20
  const mu = opts.mu ?? 1.0
  // Std-dev (cells) of the error in the per-look sub-pixel offset the SR solver is
  // given — models imperfect registration. 0 = offsets known exactly.
  const shiftError = opts.shiftError ?? 0
  // When true, the solver does NOT get the true offsets: look 0 is the reference
  // (its readings define the lattice frame the homography already put them on) and
  // every other look's sub-pixel offset is ESTIMATED from the reading grids by
  // Lucas-Kanade — the realistic, registration-surgery-free path.
  const estimateShifts = opts.estimateShifts ?? false
  const baseSeed = opts.seed ?? 0x5eed51e
  const cap = capacityBytes(spec)
  const rate = spec.rate ?? 0.6
  const from = spec.gridW * BARCODE_ROWS
  const n = spec.gridW * spec.gridH
  const usable = Math.max(1, Math.floor(cap * rate) - 13)
  const relOne = new Float32Array(n).fill(1)

  return lookCounts.map((N) => {
    let recBase = 0, recSR = 0
    for (let t = 0; t < trials; t++) {
      const rng = new Mulberry32(baseSeed + t * 2654435761 + N * 40503)
      const frameSeed = 1 + ((rng.next() * 0x7fffffff) | 0)
      const payload = new Uint8Array(usable)
      for (let i = 0; i < usable; i++) payload[i] = (rng.next() * 256) | 0
      const rgb = encodeCellsRGB(packFrameLdpc(1, frameSeed, payload, cap, rate), spec)
      const Xtrue = new Float32Array(n)
      for (let i = 0; i < n; i++) Xtrue[i] = rgb[i * 3] // bw: luminance grid

      // N sub-pixel-shifted, blurred, noisy looks of the SAME displayed frame.
      const looks: { Y: Float32Array; g: Float64Array }[] = []
      const acc = new Float64Array(cap * 8) // baseline C2 LLR accumulator
      for (let k = 0; k < N; k++) {
        // With estimateShifts, look 0 is the reference frame (zero shift) so the
        // reconstruction lands on the true lattice the demod expects.
        const dx = (estimateShifts && k === 0) ? 0 : (rng.next() * 2 - 1) * jitter
        const dy = (estimateShifts && k === 0) ? 0 : (rng.next() * 2 - 1) * jitter
        const gTrue = shiftKernel(dx, dy, sigma)                     // physics: true PSF
        const Y = applyBlurOp(Xtrue, spec.gridW, spec.gridH, from, gTrue)
        for (let i = from; i < n; i++) Y[i] += gaussian(rng) * noise
        // Kernel the SR solver actually uses — built from the registered (possibly
        // mis-estimated) offset, so shiftError degrades reconstruction realistically.
        const g = shiftError > 0
          ? shiftKernel(dx + gaussian(rng) * shiftError, dy + gaussian(rng) * shiftError, sigma)
          : gTrue
        looks.push({ Y, g })
        // Baseline arm: current best single-look front-end, then chase-combine.
        const rd: CellReadings = { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0), lum: Y, rel: relOne }
        const llr = softDemodLLR(equalizeSpatialReadings(rd, spec), spec)
        for (let i = 0; i < acc.length; i++) acc[i] += llr[i]
      }
      // Realistic path: replace each solver kernel with one built from a shift
      // ESTIMATED from the readings (look 0 = reference), not the oracle offset.
      if (estimateShifts) {
        for (let k = 1; k < N; k++) {
          const [ex, ey] = estimateShift(looks[0].Y, looks[k].Y, spec.gridW, spec.gridH, from)
          looks[k].g = shiftKernel(-ex, -ey, sigma)
        }
      }
      const base = parseFrameLdpcSoft(acc, cap, rate, false)
      if (base && base.seed === frameSeed) recBase++

      // Super-resolution arm: fuse the shifted looks, then demod once.
      const Xhat = superResolve(looks, spec.gridW, spec.gridH, from, iters, mu)
      const rdSR: CellReadings = { r: new Float32Array(0), g: new Float32Array(0), b: new Float32Array(0), lum: Xhat, rel: relOne }
      const sr = parseFrameLdpcSoft(softDemodLLR(rdSR, spec), cap, rate, false)
      if (sr && sr.seed === frameSeed) recSR++
    }
    return { looks: N, recoveredBaseline: recBase / trials, recoveredSuperRes: recSR / trials, trials }
  })
}

// ── Idea #5a: real head-to-head — 1-D vs 2-D interleave under a 2-D glare burst ──
// Uses the ACTUAL IRA-LDPC encoder/decoder with a SWAPPABLE cell↔codeword-bit
// permutation, so it is a true frame-recovery comparison, not a proxy metric.
//   1-D interleave: bitOfCell[c] = (c·s₁) mod n  (classic strided block interleaver)
//   2-D interleave: bitOfCell[(x,y)] = ((x·H + y)·s₂) mod n  (transpose + stride, so
//                   a compact 2-D patch draws from widely-separated codeword bits)
// Both are bijections (s₁,s₂ prime, coprime to n).
export interface InterleavePoint {
  patchCells: number
  patchFraction: number
  recovered1D: number
  recovered2D: number
  trials: number
}

export function simulateInterleave2D(
  W: number,
  H: number,
  patchSides: number[],
  opts: { trials?: number; rate?: number; llr?: number; noise?: number; seed?: number; iters?: number } = {},
): InterleavePoint[] {
  const trials = opts.trials ?? 60
  const rate = opts.rate ?? 0.6
  const base = opts.llr ?? 6
  const noise = opts.noise ?? 1.5
  const iters = opts.iters ?? 40
  const baseSeed = opts.seed ?? 0x217e
  const n = W * H
  const k = Math.max(1, Math.round(n * rate)), m = n - k
  const code = makeLdpcKM(k, m, 3)
  const s1 = 997, s2 = 1621 // primes, coprime to typical n; verified below
  if (n % s1 === 0 || n % s2 === 0) throw new Error('choose strides coprime to n')
  const bit1 = new Int32Array(n), bit2 = new Int32Array(n)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x
    bit1[c] = (c * s1) % n
    bit2[c] = ((x * H + y) * s2) % n
  }

  const runOne = (bitOfCell: Int32Array, rng: Mulberry32, msg: Uint8Array, side: number): boolean => {
    const parity = ldpcEncodeParity(code, msg)
    const cw = new Uint8Array(n)
    cw.set(msg, 0); cw.set(parity, k)
    const y0 = Math.floor(rng.next() * Math.max(1, H - side))
    const x0 = Math.floor(rng.next() * Math.max(1, W - side))
    const erased = new Uint8Array(n)
    for (let dy = 0; dy < side; dy++) for (let dx = 0; dx < side; dx++) erased[(y0 + dy) * W + (x0 + dx)] = 1
    const llr = new Float64Array(n)
    for (let c = 0; c < n; c++) {
      const b = bitOfCell[c]
      llr[b] = erased[c] ? 0 : (cw[b] ? -base : base) + gaussian(rng) * noise
    }
    const dec = ldpcDecodeJs(code, llr, iters)
    for (let j = 0; j < k; j++) if (dec[j] !== msg[j]) return false
    return true
  }

  return patchSides.map((side) => {
    let r1 = 0, r2 = 0
    for (let t = 0; t < trials; t++) {
      const seed = baseSeed + t * 2654435761 + side * 40503
      const msg = new Uint8Array(k)
      const mrng = new Mulberry32(seed)
      for (let j = 0; j < k; j++) msg[j] = mrng.next() < 0.5 ? 1 : 0
      // Same message + same burst location per arm (paired), independent noise draw.
      if (runOne(bit1, new Mulberry32(seed ^ 0x1111), msg, side)) r1++
      if (runOne(bit2, new Mulberry32(seed ^ 0x1111), msg, side)) r2++
    }
    return { patchCells: side * side, patchFraction: (side * side) / n, recovered1D: r1 / trials, recovered2D: r2 / trials, trials }
  })
}

// ── Idea #5b: normalized min-sum vs sum-product belief propagation ──
// A self-contained normalized-min-sum decoder over the SAME IRA-LDPC code the
// system uses. Min-sum replaces the tanh/atanh check-node rule with sign-product ×
// min-magnitude × α — far cheaper per edge (the #5b speed claim). This measures the
// frame-recovery COST of that swap vs the current sum-product decoder on the same
// noisy codewords, so the decision weighs decode-time saving against any BER loss.
/** The OLD tanh/atanh sum-product check-node rule, kept here as a fixed baseline so
 *  the min-sum comparison stays meaningful after the production decoder itself
 *  switched to min-sum. (Formerly the body of ldpcDecodeJs.) */
function ldpcSumProductRef(code: LdpcCode, llr: Float64Array, iters: number): Uint8Array {
  const { k, m, n } = code
  const checkVars: number[][] = new Array(m)
  for (let i = 0; i < m; i++) {
    const vars: number[] = []
    const row = code.checkMsgs[i]
    for (let t = 0; t < row.length; t++) vars.push(row[t])
    vars.push(k + i)
    if (i > 0) vars.push(k + i - 1)
    checkVars[i] = vars
  }
  const deg = new Int32Array(n)
  for (let i = 0; i < m; i++) { const vs = checkVars[i]; for (let t = 0; t < vs.length; t++) deg[vs[t]]++ }
  const varChk: Int32Array[] = new Array(n), varPos: Int32Array[] = new Array(n)
  for (let v = 0; v < n; v++) { varChk[v] = new Int32Array(deg[v]); varPos[v] = new Int32Array(deg[v]) }
  const fill = new Int32Array(n)
  for (let i = 0; i < m; i++) { const vs = checkVars[i]; for (let t = 0; t < vs.length; t++) { const v = vs[t], c = fill[v]++; varChk[v][c] = i; varPos[v][c] = t } }
  const msgVC: Float64Array[] = checkVars.map(vs => new Float64Array(vs.length))
  const msgCV: Float64Array[] = checkVars.map(vs => new Float64Array(vs.length))
  for (let i = 0; i < m; i++) { const vs = checkVars[i], mv = msgVC[i]; for (let t = 0; t < vs.length; t++) mv[t] = llr[vs[t]] }
  let maxDeg = 0
  for (let i = 0; i < m; i++) if (checkVars[i].length > maxDeg) maxDeg = checkVars[i].length
  const scTh = new Float64Array(maxDeg), scPre = new Float64Array(maxDeg)
  const hard = new Uint8Array(n)
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < m; i++) {
      const mv = msgVC[i], mc = msgCV[i], d = mv.length
      for (let j = 0; j < d; j++) scTh[j] = Math.tanh(mv[j] * 0.5)
      let p = 1
      for (let j = 0; j < d; j++) { scPre[j] = p; p *= scTh[j] }
      let suf = 1
      for (let j = d - 1; j >= 0; j--) {
        let prod = scPre[j] * suf
        if (prod > 0.999999999) prod = 0.999999999; else if (prod < -0.999999999) prod = -0.999999999
        mc[j] = 2 * Math.atanh(prod)
        suf *= scTh[j]
      }
    }
    for (let v = 0; v < n; v++) {
      const ch = varChk[v], ps = varPos[v], d = ch.length
      let total = llr[v]
      for (let e = 0; e < d; e++) total += msgCV[ch[e]][ps[e]]
      hard[v] = total < 0 ? 1 : 0
      for (let e = 0; e < d; e++) { const i = ch[e], t = ps[e]; msgVC[i][t] = total - msgCV[i][t] }
    }
    let ok = true
    for (let i = 0; i < m && ok; i++) { const vs = checkVars[i]; let par = 0; for (let t = 0; t < vs.length; t++) par ^= hard[vs[t]]; if (par) ok = false }
    if (ok) break
  }
  const out = new Uint8Array(k)
  for (let j = 0; j < k; j++) out[j] = hard[j]
  return out
}

function ldpcDecodeMinSum(code: LdpcCode, llr: Float64Array, iters: number, alpha: number): Uint8Array {
  const { k, m, n } = code
  const checkVars: number[][] = new Array(m)
  for (let i = 0; i < m; i++) {
    const vars: number[] = []
    const row = code.checkMsgs[i]
    for (let t = 0; t < row.length; t++) vars.push(row[t])
    vars.push(k + i)
    if (i > 0) vars.push(k + i - 1)
    checkVars[i] = vars
  }
  const deg = new Int32Array(n)
  for (let i = 0; i < m; i++) { const vs = checkVars[i]; for (let t = 0; t < vs.length; t++) deg[vs[t]]++ }
  const varChk: Int32Array[] = new Array(n), varPos: Int32Array[] = new Array(n)
  for (let v = 0; v < n; v++) { varChk[v] = new Int32Array(deg[v]); varPos[v] = new Int32Array(deg[v]) }
  const fill = new Int32Array(n)
  for (let i = 0; i < m; i++) { const vs = checkVars[i]; for (let t = 0; t < vs.length; t++) { const v = vs[t], c = fill[v]++; varChk[v][c] = i; varPos[v][c] = t } }
  const msgVC: Float64Array[] = checkVars.map(vs => new Float64Array(vs.length))
  const msgCV: Float64Array[] = checkVars.map(vs => new Float64Array(vs.length))
  for (let i = 0; i < m; i++) { const vs = checkVars[i], mv = msgVC[i]; for (let t = 0; t < vs.length; t++) mv[t] = llr[vs[t]] }
  const hard = new Uint8Array(n)
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < m; i++) {
      const mv = msgVC[i], mc = msgCV[i], d = mv.length
      for (let j = 0; j < d; j++) {
        let sign = 1, min = Infinity
        for (let l = 0; l < d; l++) {
          if (l === j) continue
          const v = mv[l]
          if (v < 0) sign = -sign
          const a = v < 0 ? -v : v
          if (a < min) min = a
        }
        mc[j] = alpha * sign * min
      }
    }
    for (let v = 0; v < n; v++) {
      const ch = varChk[v], ps = varPos[v], d = ch.length
      let total = llr[v]
      for (let e = 0; e < d; e++) total += msgCV[ch[e]][ps[e]]
      hard[v] = total < 0 ? 1 : 0
      for (let e = 0; e < d; e++) { const i = ch[e], t = ps[e]; msgVC[i][t] = total - msgCV[i][t] }
    }
    let ok = true
    for (let i = 0; i < m && ok; i++) { const vs = checkVars[i]; let par = 0; for (let t = 0; t < vs.length; t++) par ^= hard[vs[t]]; if (par) ok = false }
    if (ok) break
  }
  const out = new Uint8Array(k)
  for (let j = 0; j < k; j++) out[j] = hard[j]
  return out
}

export interface MinSumPoint {
  noise: number
  recoveredSumProduct: number
  recoveredMinSum: number
  trials: number
}

export function simulateMinSum(
  noises: number[],
  opts: { trials?: number; k?: number; rate?: number; iters?: number; alpha?: number; seed?: number } = {},
): MinSumPoint[] {
  const trials = opts.trials ?? 200
  const k = opts.k ?? 1200
  const rate = opts.rate ?? 0.6
  const iters = opts.iters ?? 40
  const alpha = opts.alpha ?? 0.8
  const baseSeed = opts.seed ?? 0x51f7
  const m = Math.round(k * (1 - rate) / rate)
  const code = makeLdpcKM(k, m, 3)
  const n = code.n

  return noises.map((noise) => {
    let sp = 0, ms = 0
    for (let t = 0; t < trials; t++) {
      const rng = new Mulberry32(baseSeed + t * 2654435761 + Math.round(noise * 1e3) * 40503)
      const msg = new Uint8Array(k)
      for (let j = 0; j < k; j++) msg[j] = rng.next() < 0.5 ? 1 : 0
      const parity = ldpcEncodeParity(code, msg)
      const cw = new Uint8Array(n); cw.set(msg, 0); cw.set(parity, k)
      const llr = new Float64Array(n)
      for (let i = 0; i < n; i++) llr[i] = (cw[i] ? -2 : 2) + gaussian(rng) * noise
      const dsp = ldpcSumProductRef(code, Float64Array.from(llr), iters)
      const dms = ldpcDecodeMinSum(code, Float64Array.from(llr), iters, alpha)
      let okSp = true, okMs = true
      for (let j = 0; j < k; j++) { if (dsp[j] !== msg[j]) okSp = false; if (dms[j] !== msg[j]) okMs = false }
      if (okSp) sp++
      if (okMs) ms++
    }
    return { noise, recoveredSumProduct: sp / trials, recoveredMinSum: ms / trials, trials }
  })
}

// ── Idea #1: WebGPU pixel-processing pipeline — THROUGHPUT MODEL (not algorithmic) ──
// WebGPU changes no frame-recovery number; it moves the O(pixels) stages (readback,
// soft demod, MIMO, reliability) off the CPU. So we model *time*, not recovery,
// grounded in the paper's measured constants (~110 ms/frame, scan ~10–12/s at
// color8 grid-64). The pixel stages scale with processed pixels ≈ (grid·pxPerCell)²;
// LDPC BP scales with codeword edges and stays on CPU/WASM either way. The single
// uncertain knob is the GPU speedup on the pixel stages — swept, to be confirmed by
// real profiling. Output: receiver fps and KB/s, CPU vs WebGPU, across grid density.
export interface ThroughputPoint {
  grid: number
  fpsCpu: number
  fpsGpu: number
  kbpsCpu: number
  kbpsGpu: number
}

export function modelWebGpuThroughput(
  grids: number[],
  opts: { pxPerCell?: number; gpuSpeedup?: number; cameraFps?: number; bitsPerCell?: number; rate?: number; gpuTransferMs?: number } = {},
): ThroughputPoint[] {
  const pxPerCell = opts.pxPerCell ?? 8
  const speedup = opts.gpuSpeedup ?? 10
  const cameraFps = opts.cameraFps ?? 30
  const bitsPerCell = opts.bitsPerCell ?? 3 // color8
  const rate = opts.rate ?? 0.6
  const transfer = opts.gpuTransferMs ?? 4
  // Calibrated so grid-64 ≈ 110 ms/frame total (≈9/s), matching the paper's end state.
  const REF = 64
  const refPixels = (REF * pxPerCell) ** 2
  const cPixelMsPerPixel = 78 / refPixels   // 78 ms of pixel-bound work at grid-64
  const cLdpcMsPerCell = 28 / (REF * REF)   // 28 ms of BP at grid-64 (scales with cells)
  const overhead = 6

  return grids.map((grid) => {
    const pixels = (grid * pxPerCell) ** 2
    const tPixel = cPixelMsPerPixel * pixels
    const tLdpc = cLdpcMsPerCell * grid * grid
    const tCpu = tPixel + tLdpc + overhead
    const tGpu = tPixel / speedup + transfer + tLdpc + overhead
    const fpsCpu = Math.min(cameraFps, 1000 / tCpu)
    const fpsGpu = Math.min(cameraFps, 1000 / tGpu)
    const bytesPerFrame = (grid * grid * bitsPerCell * rate) / 8
    return {
      grid,
      fpsCpu: Math.round(fpsCpu * 10) / 10,
      fpsGpu: Math.round(fpsGpu * 10) / 10,
      kbpsCpu: Math.round(bytesPerFrame * fpsCpu / 1024 * 10) / 10,
      kbpsGpu: Math.round(bytesPerFrame * fpsGpu / 1024 * 10) / 10,
    }
  })
}

export function runCodecLab(input: LabCase): LabResult[] {
  return [
    simulateFountain(input, 3),
    simulateFountain(input, 4),
    simulateFountain(input, 5),
    simulateFountain(input, 6),
    simulateFountain(input, 7),
    simulateIdealBlockMds(input, 16, 4),
    simulateIdealBlockMds(input, 24, 6),
    simulateIdealBlockMds(input, 32, 8),
    simulateIdealBlockMds(input, 32, 10),
  ]
}
