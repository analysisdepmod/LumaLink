// LDPC belief-propagation decoder, compiled to WebAssembly (AssemblyScript).
//
// Mirrors ldpcDecodeJs in src/services/ldpc.ts bit-for-bit — same edge-indexed
// sum-product schedule — but runs in WASM so dense grids (n up to ~2·10^5 bits)
// decode fast enough to sustain the high-throughput speed profiles.
//
// Interop is pointer-based (runtime "stub": bump allocator, no GC → object data
// never moves). JS calls init() once per code to size the buffers, writes the
// Tanner-graph CSR + channel LLRs straight into WASM memory at the exported
// pointers, calls decode(), then reads the hard bits back.

let N: i32 = 0, M: i32 = 0, EE: i32 = 0
let checkStart: Int32Array = new Int32Array(0) // CSR offsets into edges, per check (len M+1)
let edgeVar: Int32Array = new Int32Array(0)    // variable index of each edge (check-major, len EE)
let varStart: Int32Array = new Int32Array(0)   // CSR offsets into varEdge, per variable (len N+1)
let varEdge: Int32Array = new Int32Array(0)    // edge ids grouped by variable (len EE)
let msgVC: Float32Array = new Float32Array(0)  // variable→check messages, per edge
let msgCV: Float32Array = new Float32Array(0)  // check→variable messages, per edge
let llrA: Float32Array = new Float32Array(0)   // channel LLRs (len N)
let hardA: Uint8Array = new Uint8Array(0)      // hard decisions (len N)

export function init(n: i32, m: i32, e: i32): void {
  N = n; M = m; EE = e
  checkStart = new Int32Array(m + 1)
  edgeVar = new Int32Array(e)
  varStart = new Int32Array(n + 1)
  varEdge = new Int32Array(e)
  msgVC = new Float32Array(e)
  msgCV = new Float32Array(e)
  llrA = new Float32Array(n)
  hardA = new Uint8Array(n)
}

// Exported data pointers (byte offsets into the WASM memory).
export function pCheckStart(): usize { return changetype<usize>(checkStart.dataStart) }
export function pEdgeVar(): usize { return changetype<usize>(edgeVar.dataStart) }
export function pVarStart(): usize { return changetype<usize>(varStart.dataStart) }
export function pVarEdge(): usize { return changetype<usize>(varEdge.dataStart) }
export function pLlr(): usize { return changetype<usize>(llrA.dataStart) }
export function pHard(): usize { return changetype<usize>(hardA.dataStart) }

// Normalized min-sum scaling factor. MUST stay identical to MS_ALPHA in
// src/services/ldpc.ts (the JS mirror) so WASM and JS decode bit-for-bit.
const MS_ALPHA: f32 = 0.9

export function decode(iters: i32): void {
  for (let eid = 0; eid < EE; eid++) unchecked(msgVC[eid] = llrA[unchecked(edgeVar[eid])])
  for (let it = 0; it < iters; it++) {
    // Check → variable: normalized min-sum. Extrinsic magnitude = smallest |message|
    // among the OTHER edges (min1 of the check, or min2 when this edge is that min);
    // O(degree) two-minimum + total-sign pass, scaled by MS_ALPHA. No transcendentals
    // — cheaper than the old tanh/atanh rule AND far more stable near the noise cliff
    // on this IRA code. Mirrors ldpcDecodeJs exactly.
    for (let i = 0; i < M; i++) {
      const s = unchecked(checkStart[i]), e = unchecked(checkStart[i + 1]), d = e - s
      let sign: f32 = 1.0, min1: f32 = Infinity, min2: f32 = Infinity
      let arg: i32 = -1
      for (let j = 0; j < d; j++) {
        const v = unchecked(msgVC[s + j])
        if (v < 0.0) sign = -sign
        const a = v < 0.0 ? -v : v
        if (a < min1) { min2 = min1; min1 = a; arg = j } else if (a < min2) min2 = a
      }
      for (let j = 0; j < d; j++) {
        const mag = j == arg ? min2 : min1
        const sj: f32 = unchecked(msgVC[s + j]) < 0.0 ? -1.0 : 1.0
        unchecked(msgCV[s + j] = MS_ALPHA * sign * sj * mag)
      }
    }
    // Variable → check + hard decision (single belief pass reused by parity check).
    for (let v = 0; v < N; v++) {
      const s = unchecked(varStart[v]), e = unchecked(varStart[v + 1])
      let total: f32 = unchecked(llrA[v])
      for (let j = s; j < e; j++) total += unchecked(msgCV[unchecked(varEdge[j])])
      unchecked(hardA[v] = total < 0.0 ? 1 : 0)
      for (let j = s; j < e; j++) {
        const eid = unchecked(varEdge[j])
        unchecked(msgVC[eid] = total - unchecked(msgCV[eid]))
      }
    }
    // Parity check on the hard decision → early exit when all checks pass.
    let ok = true
    for (let i = 0; i < M && ok; i++) {
      let par = 0
      const s = unchecked(checkStart[i]), e = unchecked(checkStart[i + 1])
      for (let t = s; t < e; t++) par ^= unchecked(hardA[unchecked(edgeVar[t])])
      if (par != 0) ok = false
    }
    if (ok) break
  }
}
