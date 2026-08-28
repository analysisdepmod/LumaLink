// Multi-look spatial super-resolution for screen→camera (proposed receiver stage).
//
// The temporal soft-combiner (softReceiver.ts) fuses several captures of the SAME
// displayed frame at the LLR level — that only averages NOISE, so the blur (ISI
// between neighbouring cells) survives every look identically. But hand jitter
// shifts each capture by a sub-pixel amount, so the looks are NOT redundant: each
// sees the cell grid through a differently-shifted point-spread function. Fusing N
// shifted, blurred looks by multi-frame deconvolution recovers cell detail no single
// look — and no amount of noise-averaging — can, breaking the single-capture blur
// cutoff. Sim-proven (codecLab.simulateSuperResolution): at heavy blur where the
// equalizer+chase baseline saturates, 4 looks recover 100%.
//
// The sub-pixel offsets are ESTIMATED from the reading grids themselves by
// Lucas-Kanade — the homography already put every look on the cell lattice, so this
// needs only the residual inter-look motion and requires NO registration change.
// (Sim: estimated offsets match oracle offsets for recovery.)
//
// This operates on cell READINGS (pre-demod), unlike softReceiver which combines
// post-demod LLRs; the two are complementary and a receiver can run whichever the
// channel needs. Fusion falls back to the reference look when it can't help.

/** Bilinear sample of grid A at fractional (x,y), edge-clamped. */
function bilinearSample(A: Float32Array, W: number, H: number, x: number, y: number): number {
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0
  const fx = x - x0, fy = y - y0
  const a = A[y0 * W + x0], b = A[y0 * W + x1], c = A[y1 * W + x0], d = A[y1 * W + x1]
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

/**
 * Estimate the sub-pixel shift between `ref` and `tgt` (iterative Lucas-Kanade)
 * from the reading grids. Returns [dx,dy] in cells such that ref ≈ tgt(x+dx,y+dy)
 * (i.e. the sign opposite to how the content moved from ref to tgt). fuseLooks
 * consumes it with the matching sign, so callers rarely care about the convention.
 */
export function estimateSubpixelShift(ref: Float32Array, tgt: Float32Array, gridW: number, gridH: number, from: number): [number, number] {
  let dx = 0, dy = 0
  const y0 = Math.max(1, Math.ceil(from / gridW) + 1)
  for (let iter = 0; iter < 6; iter++) {
    let A = 0, B = 0, C = 0, D = 0, E = 0
    for (let y = y0; y < gridH - 1; y++) for (let x = 1; x < gridW - 1; x++) {
      const i = y * gridW + x
      const gx = (ref[i + 1] - ref[i - 1]) * 0.5
      const gy = (ref[i + gridW] - ref[i - gridW]) * 0.5
      const tw = bilinearSample(tgt, gridW, gridH, x + dx, y + dy)
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

/** 3×3 Gaussian sampling kernel centred at a sub-pixel shift (cell units). */
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

/** Forward blur A: Y[i] = Σ g[o]·X[i+o]. Barcode prefix passes through exactly. */
function blur(X: Float32Array, W: number, H: number, from: number, g: Float64Array, out: Float32Array): void {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (i < from) { out[i] = X[i]; continue }
    let acc = 0
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy
      const j = (yy >= 0 && yy < H && xx >= 0 && xx < W) ? yy * W + xx : i
      acc += g[(oy + 1) * 3 + (ox + 1)] * X[j]
    }
    out[i] = acc
  }
}

/** Transpose blur Aᵀ: scatter each residual back through the same kernel. */
function blurT(R: Float32Array, W: number, H: number, from: number, g: Float64Array, out: Float32Array): void {
  out.fill(0)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (i < from) { out[i] += R[i]; continue }
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy
      const j = (yy >= 0 && yy < H && xx >= 0 && xx < W) ? yy * W + xx : i
      out[j] += g[(oy + 1) * 3 + (ox + 1)] * R[i]
    }
  }
}

export interface FuseOptions {
  sigma?: number  // assumed PSF width in cells (the blur to invert)
  iters?: number  // Landweber iterations
  mu?: number     // step size
}

/**
 * Fuse N reading grids of the same displayed frame into one deblurred grid.
 * `looks[0]` is the reference (its lattice frame is kept); the others' sub-pixel
 * offsets are estimated from the readings. Returns a new grid; on a single look it
 * returns a copy of it unchanged.
 */
export function fuseLooks(looks: Float32Array[], gridW: number, gridH: number, from: number, opts: FuseOptions = {}): Float32Array {
  const n = gridW * gridH, N = looks.length
  const X = new Float32Array(n)
  if (N === 0) return X
  if (N === 1) { X.set(looks[0]); return X }
  const sigma = opts.sigma ?? 0.7
  const iters = opts.iters ?? 20
  const mu = opts.mu ?? 1.0

  // Reference look uses a zero-shift kernel; each other look's kernel is built from
  // its estimated offset (negated: the solver forward-models where the reference
  // content lands in that look).
  const kernels: Float64Array[] = new Array(N)
  kernels[0] = shiftKernel(0, 0, sigma)
  for (let k = 1; k < N; k++) {
    const [ex, ey] = estimateSubpixelShift(looks[0], looks[k], gridW, gridH, from)
    kernels[k] = shiftKernel(-ex, -ey, sigma)
  }

  for (const l of looks) for (let i = 0; i < n; i++) X[i] += l[i] / N // init = aligned average
  const Yhat = new Float32Array(n), res = new Float32Array(n), bp = new Float32Array(n), grad = new Float32Array(n)
  for (let it = 0; it < iters; it++) {
    grad.fill(0)
    for (let k = 0; k < N; k++) {
      blur(X, gridW, gridH, from, kernels[k], Yhat)
      for (let i = 0; i < n; i++) res[i] = looks[k][i] - Yhat[i]
      blurT(res, gridW, gridH, from, kernels[k], bp)
      for (let i = 0; i < n; i++) grad[i] += bp[i]
    }
    for (let i = 0; i < n; i++) X[i] += (mu / N) * grad[i]
  }
  return X
}

/**
 * Buffers reading grids that the caller has grouped as the SAME displayed frame
 * (e.g. by the sign-correlation identity softReceiver already computes) and fuses
 * them on demand. Reset when the displayed frame advances.
 */
export class SuperReceiver {
  private looks: Float32Array[] = []
  constructor(private readonly gridW: number, private readonly gridH: number, private readonly from: number, private readonly maxLooks = 6) {}

  /** Add one look's per-cell readings (a copy is kept). */
  feed(grid: Float32Array): void {
    if (this.looks.length >= this.maxLooks) this.looks.shift()
    this.looks.push(Float32Array.from(grid))
  }

  get count(): number { return this.looks.length }

  /** Fused deblurred grid, or the single look, or null if empty. */
  fuse(opts?: FuseOptions): Float32Array | null {
    if (this.looks.length === 0) return null
    return fuseLooks(this.looks, this.gridW, this.gridH, this.from, opts)
  }

  reset(): void { this.looks = [] }
}
