import { modelWebGpuThroughput, runCodecLab, simulateColorVQ, simulateEqualizerGain, simulateGlareBurst, simulateInterleave2D, simulateMinSum, simulateSingleFrameDeconv, simulateSuperResolution } from '../src/services/codecLab.ts'
import type { EncodingSpec } from '../src/services/visualCodec.ts'

const input = { k: 461, successRate: 0.876, trials: 200, seed: 0x9e3779b9 }
console.table(runCodecLab(input))

// Spatial (MTF) equalizer gain vs blur strength — frame recovery on vs off,
// through the real encode→optical-channel→decode pipeline (paper methodology A).
const spills = [0.22, 0.25, 0.28, 0.30, 0.32]
for (const enc of ['bw', 'color8'] as const) {
  const spec: EncodingSpec = { enc, gridW: 64, gridH: 64, rate: 0.6 }
  const rows = simulateEqualizerGain(spec, spills, { trials: 120, noise: 40 }).map((p) => ({
    enc, spill: p.spill,
    'recover OFF': (p.recoveredWithout * 100).toFixed(0) + '%',
    'recover ON': (p.recoveredWith * 100).toFixed(0) + '%',
    'gain (pt)': Math.round((p.recoveredWith - p.recoveredWithout) * 100),
  }))
  console.log(`\nMTF equalizer — ${enc} 64×64 r0.6, noise=40, 120 trials/level`)
  console.table(rows)
}

// Multi-look super-resolution (proposed) vs current best (equalizer + C2 chase),
// under heavy cross-cell blur where noise-averaging alone cannot close the frame.
{
  const spec: EncodingSpec = { enc: 'bw', gridW: 64, gridH: 64, rate: 0.6 }
  const rows = simulateSuperResolution(spec, [1, 2, 4, 6], { trials: 80, sigma: 0.62, jitter: 0.5, noise: 12 }).map((p) => ({
    looks: p.looks,
    'baseline eq+C2': (p.recoveredBaseline * 100).toFixed(0) + '%',
    'super-resolution': (p.recoveredSuperRes * 100).toFixed(0) + '%',
    'gain (pt)': Math.round((p.recoveredSuperRes - p.recoveredBaseline) * 100),
  }))
  console.log('\nMulti-look super-resolution — bw 64×64 r0.6, σ=0.62, jitter=0.5, noise=12, 80 trials/level')
  console.table(rows)
}

// #3: multi-step deconvolution vs the production 1-step unsharp (single look).
for (const enc of ['bw', 'color16'] as const) {
  const spec: EncodingSpec = { enc, gridW: 64, gridH: 64, rate: 0.6 }
  const rows = simulateSingleFrameDeconv(spec, [0.45, 0.52, 0.58, 0.62], { trials: 80, noise: enc === 'bw' ? 12 : 10, iters: 12 }).map((p) => ({
    sigma: p.sigma,
    raw: (p.recoveredRaw * 100).toFixed(0) + '%',
    'unsharp (now)': (p.recoveredUnsharp * 100).toFixed(0) + '%',
    'deconv (K-step)': (p.recoveredDeconv * 100).toFixed(0) + '%',
  }))
  console.log(`\n#3 single-frame deconvolution — ${enc} 64×64 r0.6, 80 trials/level`)
  console.table(rows)
}

// #5a: does the current 1-D interleave already tolerate a 2-D glare burst?
{
  const spec: EncodingSpec = { enc: 'bw', gridW: 64, gridH: 64, rate: 0.6 }
  const rows = simulateGlareBurst(spec, [8, 12, 16, 20, 24], { trials: 80 }).map((p) => ({
    'patch (cells²)': p.patchCells,
    'of data': (p.patchFraction * 100).toFixed(0) + '%',
    recovered: (p.recovered * 100).toFixed(0) + '%',
  }))
  console.log('\n#5a glare-burst tolerance (current 1-D interleave) — bw 64×64 r0.6, 80 trials/level')
  console.table(rows)
}

// #4 direct: joint 3-D colour VQ vs linear-MIMO + per-channel, under gamma+cross-talk.
{
  const rows = simulateColorVQ([0, 0.05, 0.1, 0.15, 0.2, 0.25], { trials: 4000 }).map((p) => ({
    crosstalk: p.crosstalk,
    'baseline SER': (p.serBaseline * 100).toFixed(1) + '%',
    'VQ SER': (p.serVQ * 100).toFixed(1) + '%',
  }))
  console.log('\n#4 colour VQ vs per-channel — SER, gamma=2.2, noise=10, 4000 symbols')
  console.table(rows)
}

// #5a direct head-to-head: 1-D vs 2-D interleave through the real LDPC.
{
  const rows = simulateInterleave2D(48, 48, [20, 24, 26, 28], { trials: 80, noise: 2.5 }).map((p) => ({
    'patch %': (p.patchFraction * 100).toFixed(0) + '%',
    '1-D': (p.recovered1D * 100).toFixed(0) + '%',
    '2-D': (p.recovered2D * 100).toFixed(0) + '%',
  }))
  console.log('\n#5a 1-D vs 2-D interleave (real LDPC) — 48×48 r0.6, noise=2.5, 80 trials/level')
  console.table(rows)
}

// #5b direct: sum-product vs normalized min-sum near the cliff.
{
  const rows = simulateMinSum([1.2, 1.3, 1.4, 1.5, 1.6], { trials: 150, k: 1200 }).map((p) => ({
    noise: p.noise,
    'sum-product': (p.recoveredSumProduct * 100).toFixed(0) + '%',
    'norm. min-sum': (p.recoveredMinSum * 100).toFixed(0) + '%',
  }))
  console.log('\n#5b sum-product vs normalized min-sum — k=1200 r0.6, 150 trials/level')
  console.table(rows)
}

// #1 WebGPU throughput MODEL (performance projection, not algorithmic).
{
  const rows = modelWebGpuThroughput([64, 96, 128, 192, 256]).map((p) => ({
    'grid²': p.grid,
    'CPU fps': p.fpsCpu, 'CPU KB/s': p.kbpsCpu,
    'WebGPU fps': p.fpsGpu, 'WebGPU KB/s': p.kbpsGpu,
  }))
  console.log('\n#1 WebGPU throughput MODEL — color8, pxPerCell=8, GPU speedup=10×, camera 30fps (needs profiling)')
  console.table(rows)
}
