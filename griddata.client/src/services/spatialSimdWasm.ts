// Optional WebAssembly-SIMD backend for the spatial equalizer.  Instantiation
// is deliberately best-effort: a browser that lacks SIMD simply keeps the
// scalar TypeScript filter with the same numerical contract.

import wasmUrl from './spatialSimd.wasm?url'

interface Exports {
  memory: WebAssembly.Memory
  init(n: number): void
  pObserved(): number
  pInput(): number
  pOutput(): number
  unsharp(w: number, h: number, from: number, strength: number, lo: number, hi: number): void
  deconvolve(w: number, h: number, from: number, spill: number, lo: number, hi: number, iters: number): void
}

export interface SpatialSimd {
  unsharp(src: Float32Array, dst: Float32Array, w: number, h: number, from: number, strength: number, lo: number, hi: number): void
  deconvolve(src: Float32Array, dst: Float32Array, w: number, h: number, from: number, spill: number, lo: number, hi: number, iters: number): void
}

export async function loadSpatialSimd(): Promise<SpatialSimd | null> {
  try {
    const res = await fetch(wasmUrl)
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), { env: { abort() { throw new Error('wasm abort') } } })
    const ex = instance.exports as unknown as Exports
    let cap = 0, vin: Float32Array, vout: Float32Array
    const ensure = (n: number) => {
      if (n <= cap) return
      ex.init(n)
      vin = new Float32Array(ex.memory.buffer, ex.pInput(), n)
      vout = new Float32Array(ex.memory.buffer, ex.pOutput(), n)
      cap = n
    }
    return {
      unsharp(src, dst, w, h, from, strength, lo, hi) {
        ensure(src.length)
        vin.set(src)
        ex.unsharp(w, h, from, strength, lo, hi)
        dst.set(vout.subarray(0, src.length))
      },
      deconvolve(src, dst, w, h, from, spill, lo, hi, iters) {
        ensure(src.length)
        vin.set(src)
        ex.deconvolve(w, h, from, spill, lo, hi, iters)
        dst.set(vout.subarray(0, src.length))
      },
    }
  } catch {
    return null
  }
}
