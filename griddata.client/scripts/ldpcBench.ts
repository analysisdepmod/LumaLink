import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { makeLdpcKM, ldpcDecodeJs } from '../src/services/ldpc.ts'
import { instantiateLdpcWasm } from '../src/services/ldpcWasmCore.ts'

const code = makeLdpcKM(7504, 4504) // ~Color8 64x64-scale codeword
const llr = new Float32Array(code.n)
let state = 123456789
for (let i = 0; i < llr.length; i++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  llr[i] = state & 1 ? 0.7 : -0.7
}

const wasm = await instantiateLdpcWasm(readFileSync(new URL('../src/services/ldpcbp.wasm', import.meta.url)))
wasm.decode(code, llr, 2)
let started = performance.now()
for (let i = 0; i < 5; i++) wasm.decode(code, llr, 12)
const wasmMs = (performance.now() - started) / 5

started = performance.now()
ldpcDecodeJs(code, llr, 12)
const jsMs = performance.now() - started

console.log(JSON.stringify({
  bits: code.n,
  iterations: 12,
  wasmMs: Number(wasmMs.toFixed(2)),
  jsMs: Number(jsMs.toFixed(2)),
  speedup: Number((jsMs / wasmMs).toFixed(2)),
}))
