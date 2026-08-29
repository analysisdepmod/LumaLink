// Soft-decision LDPC inner code (IRA — Irregular Repeat-Accumulate construction).
//
// Why LDPC over Reed-Solomon here: RS works on HARD symbol decisions and is great
// for bursts, but it throws away how *confident* each cell read was. Our colour
// demod knows that confidence (distance of a cell reading to the nearest
// calibration level). Feeding that as a per-bit log-likelihood (LLR) into an
// LDPC belief-propagation decoder recovers frames at noise levels where hard RS
// gives up — the soft information is worth ~1–2 dB, i.e. denser grids / more
// colours read reliably. Interleaving still handles the burst side.
//
// IRA is chosen because it encodes in O(n) via an accumulator (dual-diagonal
// parity), so there's no dense matrix inversion, yet it decodes with the same
// sum-product BP as any LDPC. The parity-check structure:
//   check i:  (⊕ message bits wired to check i)  ⊕  p_i  ⊕  p_{i-1}  = 0
// so encoding is p_i = a_i ⊕ p_{i-1} (a_i = parity of the message bits on row i).

export interface LdpcCode {
  k: number                // message bits
  m: number                // parity bits (= number of checks)
  n: number                // codeword bits = k + m
  msgChecks: Int32Array[]  // for each message bit, the check rows it joins
  checkMsgs: Int32Array[]  // for each check, the message bits wired to it
}

// Normalized min-sum scaling factor for the check-node update. This IRA code has
// many degree-2 (accumulator) parity nodes; on such graphs plain sum-product BP
// over-estimates reliability around the short cycles and collapses near the noise
// cliff, while normalized min-sum stays stable. Measured through the real pipeline
// (codecLab.simulateMinSum): identical to sum-product at low noise, far better at
// the cliff (e.g. noise 1.4: 8% → 93% frame recovery) and never worse — plus it is
// cheaper per edge (no tanh/atanh). α≈0.9 was the best-recovering value swept.
// MUST stay identical to MS_ALPHA in assembly/ldpcbp.ts (the WASM mirror).
const MS_ALPHA = 0.9

/**
 * Build a deterministic IRA-LDPC code for `k` message bits at ~`rate`.
 * `dv` is the message-bit degree (checks per message bit). Deterministic PRNG
 * seeded by (k,m,dv) so sender and receiver build the identical code.
 */
export function makeLdpc(k: number, rate = 0.5, dv = 3): LdpcCode {
  const m = Math.max(1, Math.round(k * (1 - rate) / rate)) // parity bits
  return makeLdpcKM(k, m, dv)
}

/** Build an IRA-LDPC code with an EXPLICIT message-bit count k and parity count m. */
export function makeLdpcKM(k: number, m: number, dv = 3): LdpcCode {
  const checkMsgsArr: number[][] = Array.from({ length: m }, () => [])
  const msgChecksArr: number[][] = Array.from({ length: k }, () => [])
  let s = ((k * 2654435761) ^ (m * 40503) ^ (dv * 668265263)) >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // Wire each message bit to `dv` distinct checks, spreading load roughly evenly.
  for (let j = 0; j < k; j++) {
    const used = new Set<number>()
    for (let d = 0; d < dv; d++) {
      let c = 0, tries = 0
      do { c = (rnd() * m) | 0; tries++ } while (used.has(c) && tries < 20)
      used.add(c)
      msgChecksArr[j].push(c)
      checkMsgsArr[c].push(j)
    }
  }
  return {
    k, m, n: k + m,
    msgChecks: msgChecksArr.map(a => Int32Array.from(a)),
    checkMsgs: checkMsgsArr.map(a => Int32Array.from(a)),
  }
}

/** Systematic IRA encode: message bits (0/1) → parity bits (0/1), length m. */
export function ldpcEncodeParity(code: LdpcCode, msg: Uint8Array): Uint8Array {
  const p = new Uint8Array(code.m)
  let prev = 0
  for (let i = 0; i < code.m; i++) {
    let a = 0
    const row = code.checkMsgs[i]
    for (let t = 0; t < row.length; t++) a ^= msg[row[t]] & 1
    prev = a ^ prev // p_i = a_i ⊕ p_{i-1}  (accumulator)
    p[i] = prev
  }
  return p
}

/**
 * Sum-product (belief-propagation) soft decode. `llr` holds channel LLRs for all
 * n = k+m codeword bits (message bits first, then parity), where LLR > 0 favours
 * bit 0. Returns the decoded message bits (length k). `iters` caps iterations;
 * it exits early once the parity checks are all satisfied.
 */
// Pluggable belief-propagation backend. The Web Worker installs a WASM-backed
// decoder here once it finishes instantiating (ldpcWasm.ts); until then — and in
// any non-worker context — this stays null and the optimized JS path below runs.
// Both produce identical output; WASM is purely a speed upgrade for dense grids.
export type SoftBits = Float32Array | Float64Array
export type BpBackend = (code: LdpcCode, llr: SoftBits, iters: number) => Uint8Array
export type BpMappedBackend = (code: LdpcCode, llr: SoftBits, iters: number, bytePermutation: Uint32Array, whiteMask: Uint8Array) => Uint8Array
let bpBackend: BpBackend | null = null
let bpMappedBackend: BpMappedBackend | null = null
export function setBpDecoder(fn: BpBackend | null, mapped: BpMappedBackend | null = null): void {
  bpBackend = fn
  bpMappedBackend = mapped
}

export function ldpcDecode(code: LdpcCode, llr: SoftBits, iters = 40): Uint8Array {
  if (bpBackend) {
    // If the WASM backend ever throws (memory/instantiation edge case), fall back
    // to the JS decoder instead of letting the exception bubble up and freeze the
    // worker. Identical output either way.
    try { return bpBackend(code, llr, iters) } catch { /* fall through to JS */ }
  }
  return ldpcDecodeJs(code, llr, iters)
}

/** Decode transmitted byte-interleaved LLRs. The WASM backend writes them into
 * its own input arena in codeword order while applying whitening, eliminating
 * the old Float64 deinterleave allocation followed by a second WASM copy. */
export function ldpcDecodeMapped(code: LdpcCode, llr: SoftBits, bytePermutation: Uint32Array, whiteMask: Uint8Array, iters = 40): Uint8Array {
  if (bpMappedBackend) {
    try { return bpMappedBackend(code, llr, iters, bytePermutation, whiteMask) } catch { /* JS fallback below */ }
  }
  const mapped = new Float32Array(code.n)
  for (let srcByte = 0; srcByte < bytePermutation.length; srcByte++) {
    const src = srcByte * 8, dst = bytePermutation[srcByte] * 8
    for (let bit = 0; bit < 8 && dst + bit < code.n; bit++) {
      const index = dst + bit
      const value = llr[src + bit]
      mapped[index] = whiteMask[index] ? -value : value
    }
  }
  return ldpcDecode(code, mapped, iters)
}

/** Reference JS belief-propagation decoder (WASM mirrors this exactly). */
export function ldpcDecodeJs(code: LdpcCode, llr: SoftBits, iters = 40): Uint8Array {
  const { k, m, n } = code
  // Tanner graph edges. Each check i connects: its message bits + p_i + p_{i-1}.
  // Variable index space: 0..k-1 = message, k..k+m-1 = parity bit i → k+i.
  const checkVars: number[][] = new Array(m)
  for (let i = 0; i < m; i++) {
    const vars: number[] = []
    const row = code.checkMsgs[i]
    for (let t = 0; t < row.length; t++) vars.push(row[t])
    vars.push(k + i)                 // p_i
    if (i > 0) vars.push(k + i - 1)  // p_{i-1}
    checkVars[i] = vars
  }
  // Per-variable EDGE index: which (check, position-in-check) each variable joins.
  // Precomputing this once removes the per-iteration `indexOf` scans that used to
  // dominate the variable-update loop — the main JS hot-path cost.
  const deg = new Int32Array(n)
  for (let i = 0; i < m; i++) { const vs = checkVars[i]; for (let t = 0; t < vs.length; t++) deg[vs[t]]++ }
  const varChk: Int32Array[] = new Array(n)
  const varPos: Int32Array[] = new Array(n)
  for (let v = 0; v < n; v++) { varChk[v] = new Int32Array(deg[v]); varPos[v] = new Int32Array(deg[v]) }
  const fill = new Int32Array(n)
  for (let i = 0; i < m; i++) {
    const vs = checkVars[i]
    for (let t = 0; t < vs.length; t++) { const v = vs[t], c = fill[v]++; varChk[v][c] = i; varPos[v][c] = t }
  }
  // Edge-indexed message stores: msgVC[i][t] aligns with checkVars[i][t].
  const msgVC: Float64Array[] = checkVars.map(vs => new Float64Array(vs.length))
  const msgCV: Float64Array[] = checkVars.map(vs => new Float64Array(vs.length))
  for (let i = 0; i < m; i++) { const vs = checkVars[i], mv = msgVC[i]; for (let t = 0; t < vs.length; t++) mv[t] = llr[vs[t]] }

  const hard = new Uint8Array(n)
  for (let it = 0; it < iters; it++) {
    // Check → variable: normalized min-sum. The extrinsic (exclude-own) magnitude is
    // the smallest |message| among the OTHER edges, so it is the min1 of the check
    // unless this edge IS that minimum, in which case it is min2 — an O(degree) pass
    // for the two smallest magnitudes + the total sign. Scaled by MS_ALPHA. This
    // MUST match assembly/ldpcbp.ts bit-for-bit (same f64 ops, no transcendentals).
    for (let i = 0; i < m; i++) {
      const mv = msgVC[i], mc = msgCV[i], d = mv.length
      let sign = 1, min1 = Infinity, min2 = Infinity, arg = -1
      for (let j = 0; j < d; j++) {
        const v = mv[j]
        if (v < 0) sign = -sign
        const a = v < 0 ? -v : v
        if (a < min1) { min2 = min1; min1 = a; arg = j } else if (a < min2) min2 = a
      }
      for (let j = 0; j < d; j++) {
        const mag = j === arg ? min2 : min1
        const sj = mv[j] < 0 ? -1 : 1
        mc[j] = MS_ALPHA * sign * sj * mag
      }
    }
    // Variable → check + hard decision, single belief pass reused by the parity check.
    for (let v = 0; v < n; v++) {
      const ch = varChk[v], ps = varPos[v], d = ch.length
      let total = llr[v]
      for (let e = 0; e < d; e++) total += msgCV[ch[e]][ps[e]]
      hard[v] = total < 0 ? 1 : 0
      for (let e = 0; e < d; e++) { const i = ch[e], t = ps[e]; msgVC[i][t] = total - msgCV[i][t] }
    }
    // Parity check on the hard decision → early exit when all checks satisfied.
    let ok = true
    for (let i = 0; i < m && ok; i++) {
      const vs = checkVars[i]; let par = 0
      for (let t = 0; t < vs.length; t++) par ^= hard[vs[t]]
      if (par) ok = false
    }
    if (ok) break
  }
  const out = new Uint8Array(k)
  for (let j = 0; j < k; j++) out[j] = hard[j]
  return out
}
