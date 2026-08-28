class Mulberry32 {
  private state: number
  constructor(seed: number) { this.state = seed >>> 0 }
  nextUInt(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return (t ^ (t >>> 14)) >>> 0
  }
  nextDouble(): number { return this.nextUInt() / 4294967296 }
}

const C = 0.03
const DELTA = 0.5
// A clean Turbo ×2 link can still miss 15–20% of the *displayed* systematic
// frames: it sees only one camera exposure per symbol, not every display flip.
// At K≈460 that leaves 70–90 unknown chunks, so a 56-chunk-only tail solver
// starts too late and many subsequently received direct packets are redundant.
// 96 stays deliberately bounded (small enough for a worker and its 902-byte
// chunks) while covering the measured optical loss window.
const DENSE_TAIL_LIMIT = 96
const cdfCache = new Map<number, Float64Array>()

function buildCdf(k: number): Float64Array {
  const mu = new Float64Array(k)
  const s = C * Math.log(k / DELTA) * Math.sqrt(k)
  const threshold = Math.max(1, Math.round(k / s))
  for (let i = 0; i < k; i++) {
    const d = i + 1
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1))
    let tau: number
    if (d < threshold) tau = s / (d * k)
    else if (d === threshold) tau = (s * Math.log(s / DELTA)) / k
    else tau = 0
    mu[i] = rho + tau
  }
  let z = 0
  for (let i = 0; i < k; i++) z += mu[i]
  const cdf = new Float64Array(k)
  let acc = 0
  for (let i = 0; i < k; i++) { acc += mu[i] / z; cdf[i] = acc }
  cdf[k - 1] = 1
  return cdf
}

function getCdf(k: number): Float64Array {
  let c = cdfCache.get(k)
  if (!c) { c = buildCdf(k); cdfCache.set(k, c) }
  return c
}

function sampleDegree(u: number, k: number): number {
  const cdf = getCdf(k)
  let lo = 0, hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (u < cdf[mid]) hi = mid; else lo = mid + 1
  }
  return lo + 1
}

function sampleDistinct(rng: Mulberry32, k: number, d: number): number[] {
  if (d >= k) { const out = new Array(k); for (let i = 0; i < k; i++) out[i] = i; return out }
  const seen = new Set<number>()
  const res: number[] = []
  while (res.length < d) {
    let j = Math.floor(rng.nextDouble() * k)
    if (j >= k) j = k - 1
    if (!seen.has(j)) { seen.add(j); res.push(j) }
  }
  return res
}

export function indicesForSeed(seed: number, k: number, tailRepair = true, mediumWideEvery = 4): number[] {
  // Systematic fountain: seeds 1..k map to the RAW source chunk (seed-1). So the
  // first k data frames the sender emits are the plain chunks — on a clean channel
  // the receiver reconstructs in ~k frames with ZERO fountain overhead (every frame
  // is degree-1, peeled instantly). Seeds > k are Robust-Soliton coded REPAIR
  // frames that fill in whatever losses occurred. This is the Raptor-class win over
  // plain LT (where even the first chunk needs several frames to peel). Both sender
  // and receiver call this, so the mapping stays consistent with no side-channel.
  if (seed >= 1 && seed <= k) return [seed - 1]
  const rng = new Mulberry32(seed)
  const repairOrdinal = seed - k
  // Half of repair packets deliberately use a medium-wide equation. Early
  // in a transfer they wait harmlessly in the peeling graph; near completion,
  // when only one or two chunks remain, they collapse to degree one much more
  // readily than the low-degree soliton packets. This removes the long visible
  // "479/481" repair tail without any receiver-to-sender feedback channel.
  const useMediumWide = tailRepair && mediumWideEvery > 0 && repairOrdinal % mediumWideEvery === 0
  const degree = useMediumWide ? Math.min(32, k) : sampleDegree(rng.nextDouble(), k)
  return sampleDistinct(rng, k, degree)
}

interface Pending {
  data: Uint8Array
  remaining: Set<number>
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length)
  for (let i = 0; i < n; i++) dst[i] ^= src[i]
}

export class FountainDecoder {
  readonly k: number
  readonly chunkSize: number
  private readonly tailRepair: boolean
  private readonly decoded: (Uint8Array | null)[]
  private decodedCount = 0
  private readonly pending = new Map<number, Pending>()
  private readonly bySource = new Map<number, Set<number>>()
  private nextPendingId = 0
  private readonly seenSeeds = new Set<number>()
  private tailSolveTicks = 0
  private denseTailAttempts = 0
  private denseTailChunks = 0

  constructor(k: number, chunkSize: number, tailRepair = true, private readonly mediumWideEvery = 4) {
    this.k = k
    this.chunkSize = chunkSize
    this.tailRepair = tailRepair
    this.decoded = new Array(k).fill(null)
  }

  get isComplete(): boolean { return this.decodedCount >= this.k }
  get uniqueChunks(): number { return this.decodedCount }
  get receivedEquations(): number { return this.seenSeeds.size }
  get tailSolverAttempts(): number { return this.denseTailAttempts }
  get tailSolverChunks(): number { return this.denseTailChunks }

  addFrame(seed: number, data: Uint8Array): boolean {
    if (this.isComplete) return true
    if (this.seenSeeds.has(seed)) return false
    this.seenSeeds.add(seed)
    const indices = indicesForSeed(seed, this.k, this.tailRepair, this.mediumWideEvery)
    const remaining = new Set<number>()
    const payload = new Uint8Array(this.chunkSize)
    payload.set(data.subarray(0, this.chunkSize))
    for (const idx of indices) {
      const d = this.decoded[idx]
      if (d) xorInto(payload, d)
      else remaining.add(idx)
    }
    if (remaining.size === 0) return false
    const pid = this.nextPendingId++
    this.pending.set(pid, { data: payload, remaining })
    for (const idx of remaining) {
      let set = this.bySource.get(idx)
      if (!set) { set = new Set(); this.bySource.set(idx, set) }
      set.add(pid)
    }
    this.propagate(pid)
    this.tryDenseTailSolve()
    return true
  }

  /**
   * Peeling is ideal while source packets are flowing, but it can leave a small
   * set of mutually-entangled repair equations at the end.  Waiting for a rare
   * degree-one equation is the familiar slow 95–99% optical-transfer tail.
   *
   * When at most 96 chunks remain, solve the already received repair equations
   * with bounded GF(2) elimination.  Equations have already had known chunks
   * removed by `propagate`, so this is still a small worker-local problem.  It
   * runs only every eighth new equation, avoiding a general large-matrix decoder
   * on every camera reply.
   */
  private tryDenseTailSolve(): void {
    if (this.isComplete) return
    const missing = this.k - this.decodedCount
    if (missing > DENSE_TAIL_LIMIT || this.pending.size < missing || (++this.tailSolveTicks & 7) !== 0) return
    this.denseTailAttempts++

    type Row = { vars: Set<number>; data: Uint8Array }
    const basis = new Map<number, Row>()
    for (const pending of this.pending.values()) {
      const vars = new Set(pending.remaining)
      const data = pending.data.slice()
      while (vars.size > 0) {
        let pivot = this.k
        for (const index of vars) if (index < pivot) pivot = index
        const prior = basis.get(pivot)
        if (!prior) { basis.set(pivot, { vars, data }); break }
        // XOR the two sparse coefficient rows and their coded payloads.
        for (const index of prior.vars) {
          if (vars.has(index)) vars.delete(index)
          else vars.add(index)
        }
        xorInto(data, prior.data)
      }
    }
    if (basis.size < missing) return

    // Basis rows have their smallest coefficient as pivot; solve backwards so
    // every non-pivot coefficient already has a value.
    const values = new Map<number, Uint8Array>()
    for (const pivot of [...basis.keys()].sort((a, b) => b - a)) {
      const row = basis.get(pivot)!
      const value = row.data.slice()
      let ready = true
      for (const index of row.vars) {
        if (index === pivot) continue
        const known = values.get(index)
        if (!known) { ready = false; break }
        xorInto(value, known)
      }
      if (ready) values.set(pivot, value)
    }
    if (values.size !== missing) return

    for (const [index, value] of values) {
      if (!this.decoded[index]) { this.decoded[index] = value; this.decodedCount++ }
    }
    // The transfer is complete; retaining old equations wastes memory and is no
    // longer useful.  `reconstruct()` reads the solved source chunks directly.
    if (this.isComplete) { this.denseTailChunks += missing; this.pending.clear(); this.bySource.clear() }
  }

  private propagate(startPid: number): void {
    const queue: number[] = []
    if (this.pending.get(startPid)?.remaining.size === 1) queue.push(startPid)
    while (queue.length > 0) {
      const pid = queue.pop()!
      const p = this.pending.get(pid)
      if (!p || p.remaining.size !== 1) continue
      const idx = p.remaining.values().next().value as number
      const value = p.data
      this.decoded[idx] = value
      this.decodedCount++
      this.pending.delete(pid)
      this.bySource.get(idx)?.delete(pid)
      const refs = this.bySource.get(idx)
      if (refs) {
        for (const otherPid of Array.from(refs)) {
          const q = this.pending.get(otherPid)
          if (!q) continue
          xorInto(q.data, value)
          q.remaining.delete(idx)
          if (q.remaining.size === 1) queue.push(otherPid)
          else if (q.remaining.size === 0) this.pending.delete(otherPid)
        }
        this.bySource.delete(idx)
      }
      if (this.isComplete) return
    }
  }

  reconstruct(): Uint8Array {
    if (!this.isComplete) throw new Error('decoder not complete')
    const out = new Uint8Array(this.k * this.chunkSize)
    for (let i = 0; i < this.k; i++) out.set(this.decoded[i]!, i * this.chunkSize)
    return out
  }
}
