// Atomic timing-tick ownership shared by the decoder-worker pool.
// Word layout: [lane0 success, lane1 success, lane0 claim A, lane0 claim B,
// lane1 claim A, lane1 claim B]. Two claim slots let the two Turbo worker pairs
// pipeline DIFFERENT display ticks without ever LDPC-decoding the SAME tick twice.

export const TIMING_LANES = 2
export const TIMING_CLAIMS_PER_LANE = 2
export const TIMING_STATE_WORDS = TIMING_LANES + TIMING_LANES * TIMING_CLAIMS_PER_LANE
export const TIMING_DUPLICATE = -2
export const TIMING_UNCLAIMED = -1

function claimStart(lane: 0 | 1): number {
  return TIMING_LANES + lane * TIMING_CLAIMS_PER_LANE
}

/** Returns a claim-slot index, TIMING_DUPLICATE, or TIMING_UNCLAIMED when full. */
export function claimTimingTick(state: Int32Array, lane: 0 | 1, tick: number): number {
  if (Atomics.load(state, lane) === tick) return TIMING_DUPLICATE
  const start = claimStart(lane)
  for (let i = 0; i < TIMING_CLAIMS_PER_LANE; i++)
    if (Atomics.load(state, start + i) === tick) return TIMING_DUPLICATE

  for (let i = 0; i < TIMING_CLAIMS_PER_LANE; i++) {
    const slot = start + i
    const previous = Atomics.compareExchange(state, slot, TIMING_UNCLAIMED, tick)
    if (previous === TIMING_UNCLAIMED) {
      // A successful decoder may have committed while we were claiming.
      if (Atomics.load(state, lane) === tick) {
        Atomics.compareExchange(state, slot, tick, TIMING_UNCLAIMED)
        return TIMING_DUPLICATE
      }
      return slot
    }
    if (previous === tick) return TIMING_DUPLICATE
  }
  // Both slots contain other ticks. Do not block a newer display frame: decode it
  // without a reservation and let the ordinary successful-tick check protect it.
  return TIMING_UNCLAIMED
}

export function finishTimingClaim(
  state: Int32Array,
  lane: 0 | 1,
  tick: number,
  slot: number,
  succeeded: boolean,
): void {
  if (succeeded) Atomics.store(state, lane, tick)
  if (slot >= TIMING_LANES) Atomics.compareExchange(state, slot, tick, TIMING_UNCLAIMED)
}
