// SIMD kernel for the spatial optical equalizer.  It sharpens four contiguous
// cell samples at a time using a regularised 4-neighbour inverse filter.  The
// JavaScript side feature-detects this module; old browsers keep the identical
// scalar implementation.

// `observed` stays fixed through a Van Cittert solve while `input` is the
// current estimate and `output` is the next estimate.  Keeping all three in
// WASM avoids a JS↔WASM round trip for every deconvolution iteration.
let observed: Float32Array = new Float32Array(0)
let input: Float32Array = new Float32Array(0)
let output: Float32Array = new Float32Array(0)

export function init(n: i32): void {
  observed = new Float32Array(n)
  input = new Float32Array(n)
  output = new Float32Array(n)
}

export function pObserved(): usize { return changetype<usize>(observed.dataStart) }
export function pInput(): usize { return changetype<usize>(input.dataStart) }
export function pOutput(): usize { return changetype<usize>(output.dataStart) }

export function unsharp(w: i32, h: i32, from: i32, strength: f32, lo: f32, hi: f32): void {
  const n = w * h
  for (let i = 0; i < n; i++) unchecked(output[i] = input[i])
  const firstRow = (from + w - 1) / w
  const k = f32x4.splat(strength)
  const quarter = f32x4.splat(0.25)
  const vlo = f32x4.splat(lo), vhi = f32x4.splat(hi)
  for (let y = max<i32>(1, firstRow); y < h - 1; y++) {
    let x = 1
    // Four centres x..x+3; left/right loads remain inside this row.
    for (; x + 3 < w - 1; x += 4) {
      const i = y * w + x
      const c = v128.load(changetype<usize>(input.dataStart) + (<usize>i << 2))
      const l = v128.load(changetype<usize>(input.dataStart) + (<usize>(i - 1) << 2))
      const r = v128.load(changetype<usize>(input.dataStart) + (<usize>(i + 1) << 2))
      const u = v128.load(changetype<usize>(input.dataStart) + (<usize>(i - w) << 2))
      const d = v128.load(changetype<usize>(input.dataStart) + (<usize>(i + w) << 2))
      const near = f32x4.mul(f32x4.add(f32x4.add(l, r), f32x4.add(u, d)), quarter)
      let q = f32x4.add(c, f32x4.mul(k, f32x4.sub(c, near)))
      q = f32x4.min(vhi, f32x4.max(vlo, q))
      v128.store(changetype<usize>(output.dataStart) + (<usize>i << 2), q)
    }
    for (; x < w - 1; x++) {
      const i = y * w + x
      if (i < from) continue
      const near = (unchecked(input[i - 1]) + unchecked(input[i + 1]) + unchecked(input[i - w]) + unchecked(input[i + w])) * 0.25
      let q = unchecked(input[i]) + strength * (unchecked(input[i]) - near)
      if (q < lo) q = lo
      else if (q > hi) q = hi
      unchecked(output[i] = q)
    }
  }
}

/**
 * Multi-step, regularised Van Cittert inversion.  This is numerically the same
 * operation as the TypeScript fallback:
 *   X(t+1) = clamp(X(t) + Y - ((1-sp)X(t) + sp·neighbours(X(t))))
 *
 * The source is copied once into both Y and X0, then all subsequent iterations
 * stay in WASM.  Four adjacent cells are evaluated together on SIMD-capable
 * engines; the tail and borders keep the exact scalar contract.
 */
export function deconvolve(w: i32, h: i32, from: i32, spill: f32, lo: f32, hi: f32, iters: i32): void {
  const n = w * h
  for (let i = 0; i < n; i++) unchecked(observed[i] = input[i])
  const firstRow = (from + w - 1) / w
  const vsp = f32x4.splat(spill)
  const one: f32 = 1.0
  const oneMinus = f32x4.splat(one - spill)
  const quarter = f32x4.splat(0.25)
  const vlo = f32x4.splat(lo), vhi = f32x4.splat(hi)
  for (let t = 0; t < iters; t++) {
    for (let i = 0; i < n; i++) unchecked(output[i] = input[i])
    for (let y = max<i32>(1, firstRow); y < h - 1; y++) {
      let x = 1
      for (; x + 3 < w - 1; x += 4) {
        const i = y * w + x
        const c = v128.load(changetype<usize>(input.dataStart) + (<usize>i << 2))
        const l = v128.load(changetype<usize>(input.dataStart) + (<usize>(i - 1) << 2))
        const r = v128.load(changetype<usize>(input.dataStart) + (<usize>(i + 1) << 2))
        const u = v128.load(changetype<usize>(input.dataStart) + (<usize>(i - w) << 2))
        const d = v128.load(changetype<usize>(input.dataStart) + (<usize>(i + w) << 2))
        const y0 = v128.load(changetype<usize>(observed.dataStart) + (<usize>i << 2))
        const near = f32x4.mul(f32x4.add(f32x4.add(l, r), f32x4.add(u, d)), quarter)
        const blur = f32x4.add(f32x4.mul(oneMinus, c), f32x4.mul(vsp, near))
        let q = f32x4.add(c, f32x4.sub(y0, blur))
        q = f32x4.min(vhi, f32x4.max(vlo, q))
        v128.store(changetype<usize>(output.dataStart) + (<usize>i << 2), q)
      }
      for (; x < w - 1; x++) {
        const i = y * w + x
        if (i < from) continue
        const near = (unchecked(input[i - 1]) + unchecked(input[i + 1]) + unchecked(input[i - w]) + unchecked(input[i + w])) * 0.25
        const blur: f32 = (one - spill) * unchecked(input[i]) + spill * near
        let q: f32 = unchecked(input[i]) + (unchecked(observed[i]) - blur)
        if (q < lo) q = lo
        else if (q > hi) q = hi
        unchecked(output[i] = q)
      }
    }
    if (t + 1 < iters) for (let i = 0; i < n; i++) unchecked(input[i] = output[i])
  }
}
