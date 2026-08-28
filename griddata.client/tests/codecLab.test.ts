import assert from 'node:assert/strict'
import test from 'node:test'
import { runCodecLab, simulateColorVQ, simulateEqualizerGain, simulateInterleave2D, simulateMinSum, simulateSingleFrameDeconv, simulateSuperResolution } from '../src/services/codecLab.ts'
import type { EncodingSpec } from '../src/services/visualCodec.ts'

test('codec laboratory is deterministic and completes every candidate', () => {
  const input = { k: 461, successRate: 0.876, trials: 40, seed: 0x9e3779b9 }
  const first = runCodecLab(input)
  const second = runCodecLab(input)
  assert.deepEqual(first, second)
  assert.equal(first.length, 9)
  for (const result of first) {
    assert.ok(result.averageFrames >= input.k)
    assert.ok(result.worstFrames >= result.p90Frames)
  }
})

// End-to-end optical measurement: the spatial (MTF) equalizer must recover whole
// frames the identical pipeline drops when it is off, in the blur band where it
// matters. Deterministic (fixed seed), so the exact gap is reproducible. NOTE: the
// operating point is harsher than before because the decoder switched to min-sum
// (which absorbs more marginal error on its own), so the 1-step equalizer's residual
// value shows only at heavier blur. Measured at spill=0.37, noise=50: BW 88%→95%,
// color8 80%→87%.
test('spatial equalizer recovers frames the raw pipeline drops (BW & color8)', () => {
  for (const enc of ['bw', 'color8'] as const) {
    const spec: EncodingSpec = { enc, gridW: 64, gridH: 64, rate: 0.6 }
    const [pt] = simulateEqualizerGain(spec, [0.37], { trials: 60, noise: 50 })
    const a = simulateEqualizerGain(spec, [0.37], { trials: 60, noise: 50 })[0]
    assert.deepEqual(pt, a) // deterministic
    assert.ok(pt.recoveredWith > pt.recoveredWithout + 0.04,
      `${enc}: equalizer should lift recovery (${(pt.recoveredWithout * 100).toFixed(0)}% → ${(pt.recoveredWith * 100).toFixed(0)}%)`)
  }
})

// Proposed mechanism: fusing sub-pixel-shifted looks (multi-frame super-resolution)
// must beat the current best front-end (equalizer + C2 chase-combining) on the
// IDENTICAL looks, under blur heavy enough that noise-averaging alone can't close
// the frame. Deterministic. Measured at σ=0.6, jitter=0.5, noise=12 (64×64 r0.6):
// 2 looks 50%→79%, 4 looks 88%→100%.
test('multi-look super-resolution beats equalizer+chase under heavy blur', () => {
  const spec: EncodingSpec = { enc: 'bw', gridW: 64, gridH: 64, rate: 0.6 }
  // The REALISTIC path: the per-look sub-pixel offsets are ESTIMATED from the reading
  // grids by Lucas-Kanade (estimateShifts), NOT taken from an oracle — so this needs
  // no registration change. σ=0.72 is heavy enough that even the shipped multi-step
  // equalizer + chase-combining saturates, while SR's shift diversity still recovers
  // it. Measured: L2 42%→100%, L4 54%→100%. Deterministic.
  const opts = { trials: 24, sigma: 0.72, jitter: 0.5, noise: 12, estimateShifts: true }
  const pts = simulateSuperResolution(spec, [2, 4], opts)
  assert.deepEqual(pts, simulateSuperResolution(spec, [2, 4], opts))
  for (const p of pts) {
    assert.ok(p.recoveredSuperRes > p.recoveredBaseline + 0.3,
      `looks=${p.looks}: SR with estimated shifts should beat baseline (${(p.recoveredBaseline * 100).toFixed(0)}% → ${(p.recoveredSuperRes * 100).toFixed(0)}%)`)
  }
})

// Idea #3 IS NOW SHIPPED: equalizeSpatialReadings does multi-step Van Cittert
// deconvolution (not a single unsharp) and runs for color16 too. This validates the
// PRODUCTION equalizer directly — the `recoveredUnsharp` column IS the production
// path — recovering heavy-blur frames the raw pipeline drops entirely. Deterministic.
// bw σ=0.72: raw 0% → production 100%. color16 σ=0.55: raw 0% → production 90%.
test('shipped multi-step equalizer recovers heavy blur the raw pipeline drops (bw & color16)', () => {
  for (const [enc, sigma] of [['bw', 0.72], ['color16', 0.55]] as const) {
    const spec: EncodingSpec = { enc, gridW: 64, gridH: 64, rate: 0.6 }
    const [p] = simulateSingleFrameDeconv(spec, [sigma], { trials: 40, noise: enc === 'bw' ? 12 : 10 })
    assert.ok(p.recoveredUnsharp > p.recoveredRaw + 0.5,
      `${enc}: production equalizer should recover heavy blur (raw ${(p.recoveredRaw * 100).toFixed(0)}% → ${(p.recoveredUnsharp * 100).toFixed(0)}%)`)
  }
})

// Idea #4 (direct): a joint 3-D colour VQ beats linear-MIMO + per-channel decoding
// under non-linear (gamma) colour distortion — the residual a linear un-mix leaves.
// Measured at cross-talk 0.20: per-channel SER 7.5% vs VQ SER 2.8%.
test('joint 3-D colour VQ lowers symbol error vs per-channel under non-linear colour', () => {
  const [p] = simulateColorVQ([0.20], { trials: 2000 })
  assert.deepEqual([p], simulateColorVQ([0.20], { trials: 2000 }))
  assert.ok(p.serVQ < p.serBaseline - 0.02,
    `VQ should cut SER (${(p.serBaseline * 100).toFixed(1)}% → ${(p.serVQ * 100).toFixed(1)}%)`)
})

// Idea #5a (direct null result): a 2-D interleave does NOT beat the strided 1-D
// interleave on a 2-D glare burst through the real LDPC — a good 1-D interleaver
// already scatters a 2-D patch, and the failure point is code erasure-capacity, not
// interleave shape. Locks the "don't build it" conclusion.
test('2-D interleave gives no advantage over 1-D on a 2-D burst', () => {
  const pts = simulateInterleave2D(48, 48, [24], { trials: 40, noise: 2.5 })
  const p = pts[0]
  assert.ok(p.recovered1D >= p.recovered2D - 0.05,
    `2-D should not beat 1-D (1D ${(p.recovered1D * 100).toFixed(0)}% vs 2D ${(p.recovered2D * 100).toFixed(0)}%)`)
})

// Idea #5b (direct): normalized min-sum decisively out-recovers the current
// sum-product BP near the cliff on this IRA code (and is cheaper per edge). Even
// plain min-sum wins, so the current decoder is leaving margin on the table.
// Measured at noise 1.4 (k=600): sum-product 18% vs min-sum 83%.
test('normalized min-sum out-recovers the current sum-product BP near the cliff', () => {
  const [p] = simulateMinSum([1.4], { trials: 40, k: 600 })
  assert.deepEqual([p], simulateMinSum([1.4], { trials: 40, k: 600 }))
  assert.ok(p.recoveredMinSum > p.recoveredSumProduct + 0.3,
    `min-sum should beat sum-product (${(p.recoveredSumProduct * 100).toFixed(0)}% → ${(p.recoveredMinSum * 100).toFixed(0)}%)`)
})
