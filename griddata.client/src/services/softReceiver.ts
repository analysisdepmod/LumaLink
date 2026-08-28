// Temporal soft-combining receiver (feedback-free HARQ for screen→camera).
//
// A single camera capture of a dense colour frame is often too noisy for the
// LDPC decoder to close — blur, glare, a hand tremor. But the sender holds each
// on-screen frame for several camera exposures, so the camera sees the SAME
// codeword two, three, many times, each a fresh independent noise draw. Summing
// their per-bit LLRs (chase combining) raises the effective SNR ~linearly in the
// number of looks: two marginal captures that each fail can together succeed.
//
// The hard part is doing this WITHOUT a back-channel and WITHOUT a pre-decode
// frame id: the receiver must recognise "this capture is the same on-screen frame
// as the one I'm accumulating" before it has decoded either. We do it by
// correlating the SIGN pattern of the soft-demod LLRs: two captures of the same
// frame agree on the vast majority of bit signs; two different frames agree on
// only ~half. When the incoming capture correlates with the accumulator we add
// it in and re-attempt the decode; when it doesn't, the on-screen frame has
// advanced, so we finalise the old accumulator and start a new one.
//
// This is the receiver side of the joint fountain↔LDPC decoder: recovered
// chunks are peeled by the FountainDecoder (cross-graph), while this stage
// squeezes every marginal frame out of the optical channel before it gets there.

import { parseFrameLdpcSoft, type ParsedFrame } from './transferCodec'

const MATCH_THRESHOLD = 0.80 // sign-agreement fraction to call two captures "same frame"
const CLAMP = 200            // cap accumulated |LLR| so a long static hold can't overflow BP

export class SoftReceiver {
  private acc: Float64Array | null = null
  private n = 0
  /** `looks` value at the last full-BP attempt on the current accumulator, so a
   *  stubborn frame doesn't re-run 24-iteration BP on every single capture. */
  private lastBpLooks = -99
  /** How many captures are currently combined into the live accumulator. */
  looks = 0
  /** Total captures that decoded thanks to combining ≥2 looks (telemetry). */
  combinedWins = 0

  constructor(
    private readonly capacity: number,
    private readonly rate = 0.6,
    // Binary Boost is intentionally an erasure-friendly fountain stream. Its
    // hard CRC path closes clean frames cheaply; spending 24 BP rounds trying to
    // rescue a visibly torn black/white frame costs more throughput than simply
    // accepting the next independent fountain equation.
    private readonly maxBpIters = 24,
    /** For dense binary frames, wait for a second exposure before BP. */
    private readonly deferBpUntilRepeat = false,
  ) {}

  /**
   * Test whether `llr` belongs to the currently held display frame without
   * mutating the accumulator.  The spatial super-resolution stage uses the
   * exact same identity decision as chase-combining, so it never fuses looks
   * across a screen transition.
   */
  sameFrame(llr: Float64Array): boolean {
    return !!this.acc && this.n === llr.length && this.agrees(llr)
  }

  /**
   * Feed one capture's per-bit LLRs (transmit order, from softDemodLLR).
   * Returns a decoded frame as soon as the live accumulator closes, else null.
   */
  feed(llr: Float64Array): ParsedFrame | null {
    if (!this.acc || this.n !== llr.length) {
      this.acc = Float64Array.from(llr)
      this.n = llr.length
      this.looks = 1
      this.lastBpLooks = -99
    } else if (this.agrees(llr)) {
      const a = this.acc
      for (let i = 0; i < a.length; i++) {
        let v = a[i] + llr[i]
        if (v > CLAMP) v = CLAMP; else if (v < -CLAMP) v = -CLAMP
        a[i] = v
      }
      this.looks++
    } else {
      // On-screen frame changed → start fresh on this capture.
      this.acc = Float64Array.from(llr)
      this.looks = 1
      this.lastBpLooks = -99
    }

    // FAST PATH FIRST: a hard-decision + CRC check on the combined accumulator is
    // O(n) and closes any capture already strong enough — which, once a held frame
    // has accumulated a look or two, is most of them. Only when that fails do we pay
    // for full belief-propagation. This is the main scan-rate lever: it takes the
    // 24-iteration BP off EVERY frame (which pinned the CPU and made the receiver's
    // fps collapse to 0 on dense grids) and runs it only on the genuinely marginal
    // captures that need error correction. Decode success is unchanged — BP still
    // runs whenever the fast path can't close.
    // parseFrameLdpcSoft already tries the cheap fast path (hard decision + CRC)
    // before belief-propagation, so we only pick whether BP is allowed to run at all
    // this look. Full BP is the expensive part: allow it while closing is most likely
    // (the first few looks) and every 2nd new look after — re-running 24-iter BP on a
    // stubborn accumulator every single capture is what streaks the scan rate to 0.
    const bpDue = this.deferBpUntilRepeat
      // A 128² BW frame is cheap to hard-check but expensive to BP-decode. The
      // first exposure either has a clean CRC or is better combined with the
      // next camera exposure; BP on a single torn exposure was the main source
      // of the long 1–2s worker stalls in BW Boost.
      ? (this.looks >= 2 && (this.looks === 2 || this.looks - this.lastBpLooks >= 2))
      : (this.looks <= 4 || this.looks - this.lastBpLooks >= 2)
    if (bpDue) this.lastBpLooks = this.looks
    const parsed = parseFrameLdpcSoft(this.acc, this.capacity, this.rate, !bpDue, this.maxBpIters)
    if (parsed && this.looks > 1) this.combinedWins++
    return parsed
  }

  /** Sign-agreement fraction between a new capture and the accumulator. */
  private agrees(llr: Float64Array): boolean {
    const a = this.acc!
    let agree = 0, total = 0
    // Only count bits both vectors are reasonably confident about — near-zero
    // LLRs carry no sign information and would just add coin-flips to the score.
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]) < 0.5 || Math.abs(llr[i]) < 0.5) continue
      total++
      if ((a[i] < 0) === (llr[i] < 0)) agree++
    }
    if (total < a.length * 0.1) return false // too little confident overlap to judge
    return agree / total >= MATCH_THRESHOLD
  }
}
