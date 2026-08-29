// Runtime-independent adapter for the shipped LDPC WebAssembly binary.

import type { LdpcCode, SoftBits } from './ldpc'

interface WasmExports {
  memory: WebAssembly.Memory
  init(n: number, m: number, e: number): void
  decode(iters: number): void
  pCheckStart(): number
  pEdgeVar(): number
  pVarStart(): number
  pVarEdge(): number
  pLlr(): number
  pHard(): number
}

interface Flat {
  n: number; m: number; k: number; E: number
  checkStart: Int32Array; edgeVar: Int32Array; varStart: Int32Array; varEdge: Int32Array
}

function flatten(code: LdpcCode): Flat {
  const { k, m, n } = code
  const checkStart = new Int32Array(m + 1)
  let E = 0
  for (let i = 0; i < m; i++) { checkStart[i] = E; E += code.checkMsgs[i].length + (i > 0 ? 2 : 1) }
  checkStart[m] = E
  const edgeVar = new Int32Array(E)
  const varDeg = new Int32Array(n)
  let e = 0
  for (let i = 0; i < m; i++) {
    const row = code.checkMsgs[i]
    for (let t = 0; t < row.length; t++) { edgeVar[e] = row[t]; varDeg[row[t]]++; e++ }
    edgeVar[e] = k + i; varDeg[k + i]++; e++
    if (i > 0) { edgeVar[e] = k + i - 1; varDeg[k + i - 1]++; e++ }
  }
  const varStart = new Int32Array(n + 1)
  let acc = 0
  for (let v = 0; v < n; v++) { varStart[v] = acc; acc += varDeg[v] }
  varStart[n] = acc
  const varEdge = new Int32Array(E)
  const fill = new Int32Array(n)
  for (let eid = 0; eid < E; eid++) { const v = edgeVar[eid]; varEdge[varStart[v] + fill[v]++] = eid }
  return { n, m, k, E, checkStart, edgeVar, varStart, varEdge }
}

export interface WasmDecoder {
  decode(code: LdpcCode, llr: SoftBits, iters: number): Uint8Array
  decodeMapped(code: LdpcCode, llr: SoftBits, iters: number, bytePermutation: Uint32Array, whiteMask: Uint8Array): Uint8Array
}

export async function instantiateLdpcWasm(bytes: ArrayBuffer | Uint8Array): Promise<WasmDecoder> {
  const source = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes
  const { instance } = await WebAssembly.instantiate(source, {
    env: { abort() { throw new Error('wasm abort') }, 'Math.log': Math.log, 'Math.tanh': Math.tanh },
  })
  const ex = instance.exports as unknown as WasmExports
  const flatCache = new Map<string, Flat>()
  let loadedKey = ''
  let vLlr: Float32Array, vHard: Uint8Array

  const ensureCode = (code: LdpcCode): Flat => {
    const key = code.k + ':' + code.m
    let flat = flatCache.get(key)
    if (!flat) { flat = flatten(code); flatCache.set(key, flat) }
    if (loadedKey !== key) {
      ex.init(flat.n, flat.m, flat.E)
      const buf = ex.memory.buffer
      new Int32Array(buf, ex.pCheckStart(), flat.m + 1).set(flat.checkStart)
      new Int32Array(buf, ex.pEdgeVar(), flat.E).set(flat.edgeVar)
      new Int32Array(buf, ex.pVarStart(), flat.n + 1).set(flat.varStart)
      new Int32Array(buf, ex.pVarEdge(), flat.E).set(flat.varEdge)
      vLlr = new Float32Array(buf, ex.pLlr(), flat.n)
      vHard = new Uint8Array(buf, ex.pHard(), flat.n)
      loadedKey = key
    }
    return flat
  }

  return {
    decode(code, llr, iters) {
      const flat = ensureCode(code)
      vLlr.set(llr.subarray(0, flat.n))
      ex.decode(iters)
      return vHard.subarray(0, flat.k)
    },
    decodeMapped(code, llr, iters, bytePermutation, whiteMask) {
      const flat = ensureCode(code)
      for (let srcByte = 0; srcByte < bytePermutation.length; srcByte++) {
        const src = srcByte * 8, dst = bytePermutation[srcByte] * 8
        for (let bit = 0; bit < 8 && dst + bit < flat.n; bit++) {
          const index = dst + bit
          const value = llr[src + bit]
          vLlr[index] = whiteMask[index] ? -value : value
        }
      }
      ex.decode(iters)
      return vHard.subarray(0, flat.k)
    },
  }
}
