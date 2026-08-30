import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { decodeBarcodeRow, decodeTimingBarcodeRow, encodeBarcodeRow, encodeTimingBarcodeRow } from '../src/services/metaBarcode.ts'
import { FountainDecoder } from '../src/services/fountainDecoder.ts'
import { indicesForSeed } from '../src/services/fountainDecoder.ts'
import { buildTransfer, decodeManifestWire, encodeManifestFrames, encodeManifestWire, finishTransfer, fountainEncode, FRAME_TYPE_DATA, maxPayload, packFrameLdpc, parseFrameLdpcSoft, seedForDataIndex, type TransferManifest } from '../src/services/transferCodec.ts'
import { capacityBytes, encodeCellsRGB, equalizeSpatialReadings, softDemodLLR, type EncodingSpec } from '../src/services/visualCodec.ts'
import { encodeHierarchicalCells, hierarchicalLayout, hierarchicalSeeds, softDemodHierarchical } from '../src/services/hierarchicalCodec.ts'
import { estimateSubpixelShift, fuseLooks } from '../src/services/superReceiver.ts'
import { homographyCoefficients } from '../src/services/webGpuGridSampler.ts'
import { ldpcEncodeParity, makeLdpcKM } from '../src/services/ldpc.ts'
import { instantiateLdpcWasm } from '../src/services/ldpcWasmCore.ts'
import { assessOpticalLink } from '../src/services/opticalCalibration.ts'
import { sampleMapped } from '../src/services/matrixVision.ts'
import { claimTimingTick, finishTimingClaim, TIMING_DUPLICATE, TIMING_STATE_WORDS, TIMING_UNCLAIMED } from '../src/services/timingClaims.ts'

test('calibration rates measured Turbo useful capacity instead of an impossible raw ceiling', () => {
  const result = assessOpticalLink({
    goodputKBs: 10.36,
    validFrameRate: 0.881,
    averageDecodeMs: 144.16,
    chunkBytes: 902,
    ldpcRate: 0.625,
    senderFps: 12,
    lanes: 2,
    colorConfidence: 0.86,
  })
  assert.equal(result.status, 'stable')
  assert.ok(result.utilization > 0.61 && result.utilization < 0.63)
})

test('shipped SIMD Float32 WASM LDPC decodes through the zero-copy mapped input', async () => {
  const wasm = await instantiateLdpcWasm(readFileSync(new URL('../src/services/ldpcbp.wasm', import.meta.url)))
  const code = makeLdpcKM(256, 160)
  const message = new Uint8Array(code.k)
  for (let i = 0; i < message.length; i++) message[i] = ((i * 29 + 7) >>> 3) & 1
  const parity = ldpcEncodeParity(code, message)
  const llr = new Float32Array(code.n)
  for (let i = 0; i < code.k; i++) llr[i] = message[i] ? -5 : 5
  for (let i = 0; i < code.m; i++) llr[code.k + i] = parity[i] ? -5 : 5
  for (const i of [3, 77, 205, 319]) llr[i] = -Math.sign(llr[i]) * 0.4
  const bytes = code.n / 8
  const identity = Uint32Array.from({ length: bytes }, (_, i) => i)
  const decoded = wasm.decodeMapped(code, llr, 12, identity, new Uint8Array(code.n))
  assert.deepEqual([...decoded], [...message])
})

test('WebGPU sampler homography maps the unit square onto all four grid corners', () => {
  const corners = {
    tl: { x: 13, y: 21 }, tr: { x: 741, y: 47 },
    br: { x: 698, y: 612 }, bl: { x: 31, y: 570 },
  }
  const h = homographyCoefficients(corners)
  const map = (u: number, v: number) => {
    const weight = h[3] * u + h[7] * v + 1
    return { x: (h[0] * u + h[1] * v + h[2]) / weight, y: (h[4] * u + h[5] * v + h[6]) / weight }
  }
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} != ${expected}`)
  for (const [u, v, expected] of [[0, 0, corners.tl], [1, 0, corners.tr], [1, 1, corners.br], [0, 1, corners.bl]] as const) {
    const actual = map(u, v)
    close(actual.x, expected.x); close(actual.y, expected.y)
  }
})

test('metadata barcode preserves the exact non-zoned grid', () => {
  const row = encodeBarcodeRow({ version: 1, enc: 'color8', rate: 0.65, zones: false, ringWidth: 0, gridW: 64, gridH: 64 }, 64)
  const luminance = new Float32Array(64)
  for (let cell = 0; cell < 64; cell++) luminance[cell] = row[cell * 3]
  const decoded = decodeBarcodeRow(luminance, 64)
  assert.deepEqual(decoded, { version: 1, enc: 'color8', rate: 0.65, zones: false, ringWidth: 0, gridW: 64, gridH: 64 })
})

test('Fast 72x72 raises payload capacity while preserving exact barcode geometry', () => {
  const spec: EncodingSpec = { enc: 'color8', gridW: 72, gridH: 72, rate: 0.625 }
  assert.equal(maxPayload(spec), 1151)
  assert.ok(maxPayload(spec) > maxPayload({ ...spec, gridW: 64, gridH: 64 }) * 1.27)
  const row = encodeBarcodeRow({ version: 2, enc: 'color8', rate: 0.625, zones: false, ringWidth: 0, gridW: 72, gridH: 72, lanes: 2 }, 72)
  const luminance = Float32Array.from({ length: 72 }, (_, cell) => row[cell * 3])
  const decoded = decodeBarcodeRow(luminance, 72)
  assert.equal(decoded?.gridW, 72)
  assert.equal(decoded?.gridH, 72)
  assert.equal(decoded?.lanes, 2)
})

test('Fast 72x72 completes a clean end-to-end v9 transfer', async () => {
  const spec: EncodingSpec = { enc: 'color8', gridW: 72, gridH: 72, rate: 0.625 }
  const raw = new Uint8Array(18_000)
  let state = 0x12345678
  for (let i = 0; i < raw.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    raw[i] = state >>> 24
  }
  const built = await buildTransfer(raw, { kind: 'file', name: 'fast72.bin', mime: 'application/octet-stream' }, {
    spec, chunkSize: maxPayload(spec), frameCount: 1, fps: 12, lanes: 2, systematicRun: 8,
  })
  assert.equal(built.manifest.v, 9)
  assert.equal(built.manifest.chunk, 1151)
  const decoder = new FountainDecoder(built.manifest.k, built.manifest.chunk, true, 2)
  const capacity = capacityBytes(spec)
  for (let index = 0; index < built.frameCount && !decoder.isComplete; index++) {
    const frame = built.frameAt(index)
    const llr = new Float32Array(capacity * 8)
    for (let byte = 0; byte < frame.length; byte++) for (let bit = 0; bit < 8; bit++)
      llr[byte * 8 + bit] = frame[byte] & (1 << (7 - bit)) ? -12 : 12
    const parsed = parseFrameLdpcSoft(llr, capacity, spec.rate)
    if (parsed?.type === FRAME_TYPE_DATA) decoder.addFrame(parsed.seed, parsed.payload)
  }
  assert.equal(decoder.isComplete, true)
  assert.deepEqual(await finishTransfer(decoder.reconstruct(), built.manifest), raw)
})

test('Fast 72x72 centred 3x3 camera sampler preserves an LDPC frame under sensor noise', () => {
  const spec: EncodingSpec = { enc: 'color8', gridW: 72, gridH: 72, rate: 0.625 }
  const capacity = capacityBytes(spec)
  const payload = Uint8Array.from({ length: 700 }, (_, i) => (i * 73 + 19) & 0xff)
  const packed = packFrameLdpc(FRAME_TYPE_DATA, 0x72fa5701, payload, capacity, spec.rate)
  const cells = encodeCellsRGB(packed, spec)
  const cellPx = 10, w = spec.gridW * cellPx, h = spec.gridH * cellPx
  const pixels = new Uint8ClampedArray(w * h * 4)
  let noise = 0x5eed1234
  for (let gy = 0; gy < spec.gridH; gy++) for (let gx = 0; gx < spec.gridW; gx++) {
    const ci = (gy * spec.gridW + gx) * 3
    for (let y = 0; y < cellPx; y++) for (let x = 0; x < cellPx; x++) {
      noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0
      const jitter = ((noise >>> 24) % 31) - 15
      const p = ((gy * cellPx + y) * w + gx * cellPx + x) * 4
      pixels[p] = cells[ci] + jitter
      pixels[p + 1] = cells[ci + 1] + jitter
      pixels[p + 2] = cells[ci + 2] + jitter
      pixels[p + 3] = 255
    }
  }
  const readings = sampleMapped(pixels, w, h, (u, v) => ({ x: u * w, y: v * h }), spec.gridW, spec.gridH, 1)
  const parsed = parseFrameLdpcSoft(softDemodLLR(readings, spec), capacity, spec.rate, false, 12)
  assert.equal(parsed?.seed, 0x72fa5701)
  assert.deepEqual(parsed?.payload, payload)
})

test('Turbo timing claims suppress the same tick but pipeline different ticks and release failures', () => {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * TIMING_STATE_WORDS))
  state.fill(TIMING_UNCLAIMED)
  const first = claimTimingTick(state, 0, 41)
  assert.ok(first >= 0)
  assert.equal(claimTimingTick(state, 0, 41), TIMING_DUPLICATE)
  const next = claimTimingTick(state, 0, 42)
  assert.ok(next >= 0 && next !== first)
  // A failed decode releases only its own reservation, allowing a later retry.
  finishTimingClaim(state, 0, 41, first, false)
  const retry = claimTimingTick(state, 0, 41)
  assert.ok(retry >= 0)
  finishTimingClaim(state, 0, 41, retry, true)
  assert.equal(claimTimingTick(state, 0, 41), TIMING_DUPLICATE)
  // Lane 1 is independent from lane 0 even when its tick number is identical.
  assert.ok(claimTimingTick(state, 1, 41) >= 0)
  finishTimingClaim(state, 0, 42, next, false)
})

test('metadata barcode carries the 0.625 tuned LDPC rate', () => {
  const row = encodeBarcodeRow({ version: 1, enc: 'color8', rate: 0.625, zones: false, ringWidth: 0, gridW: 64, gridH: 64 }, 64)
  const luminance = new Float32Array(64)
  for (let cell = 0; cell < 64; cell++) luminance[cell] = row[cell * 3]
  assert.equal(decodeBarcodeRow(luminance, 64)?.rate, 0.625)
})

test('version 2 metadata barcode advertises Turbo x2 layout', () => {
  const row = encodeBarcodeRow({ version: 2, enc: 'color8', rate: 0.625, zones: false, ringWidth: 0, gridW: 64, gridH: 64, lanes: 2 }, 64)
  const luminance = new Float32Array(64)
  for (let cell = 0; cell < 64; cell++) luminance[cell] = row[cell * 3]
  const decoded = decodeBarcodeRow(luminance, 64)
  assert.equal(decoded?.version, 2)
  assert.equal(decoded?.lanes, 2)
})

test('timing barcode carries fractional fps, rolling tick, and lane', () => {
  const row = encodeTimingBarcodeRow({ fps: 12.5, tick: 1733, lane: 1 }, 64)
  const luminance = new Float32Array(64)
  for (let cell = 0; cell < 64; cell++) luminance[cell] = row[cell * 3]
  assert.deepEqual(decodeTimingBarcodeRow(luminance, 64), { fps: 12.5, tick: 1733 & 0x3ff, lane: 1 })
})

test('two metadata rows outvote the stronger timing row for legacy readers', () => {
  const metadata = encodeBarcodeRow({ version: 2, enc: 'color8', rate: 0.625, zones: false, ringWidth: 0, gridW: 64, gridH: 64, lanes: 2 }, 64)
  const timing = encodeTimingBarcodeRow({ fps: 12, tick: 777, lane: 0 }, 64)
  const averaged = new Float32Array(64)
  for (let cell = 0; cell < 64; cell++) averaged[cell] = (metadata[cell * 3] * 2 + timing[cell * 3]) / 3
  const decoded = decodeBarcodeRow(averaged, 64)
  assert.equal(decoded?.version, 2)
  assert.equal(decoded?.lanes, 2)
  assert.equal(decoded?.gridW, 64)
})

test('LDPC frame survives the codec fast path', () => {
  const capacity = 128
  const payload = new Uint8Array([7, 1, 9, 2, 8])
  const packed = packFrameLdpc(1, 0x12345678, payload, capacity, 0.6)
  const llr = new Float64Array(capacity * 8)
  for (let i = 0; i < packed.length; i++) {
    for (let bit = 7; bit >= 0; bit--) llr[i * 8 + (7 - bit)] = ((packed[i] >> bit) & 1) ? -9 : 9
  }
  const parsed = parseFrameLdpcSoft(llr, capacity, 0.6)
  assert.equal(parsed?.type, 1)
  assert.equal(parsed?.seed, 0x12345678)
  assert.deepEqual([...parsed!.payload], [...payload])
})

test('Color16 camera-local codebook round-trips the complete RGB palette', () => {
  const spec: EncodingSpec = { enc: 'color16', gridW: 64, gridH: 64, rate: 0.6 }
  const payload = new Uint8Array(capacityBytes(spec))
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 19) & 0xff
  const rgb = encodeCellsRGB(payload, spec)
  const n = spec.gridW * spec.gridH
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    r[i] = rgb[i * 3]; g[i] = rgb[i * 3 + 1]; b[i] = rgb[i * 3 + 2]
    lum[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114
  }
  const llr = softDemodLLR({ r, g, b, lum, rel: new Float32Array(n).fill(1) }, spec)
  for (let i = 0; i < payload.length * 8; i++) {
    const bit = (payload[i >> 3] >> (7 - (i & 7))) & 1
    assert.ok(bit ? llr[i] < 0 : llr[i] > 0, `incorrect Color16 bit ${i}`)
  }
})

test('hierarchical macrocell carries a robust base and an enhancement stream', () => {
  const spec = { gridW: 128, gridH: 128 }
  const layout = hierarchicalLayout(spec)
  assert.equal(layout.capacity, 496)
  const base = new Uint8Array(layout.capacity), enhancement = new Uint8Array(layout.capacity)
  for (let i = 0; i < layout.capacity; i++) { base[i] = (i * 31 + 7) & 0xff; enhancement[i] = (i * 47 + 11) & 0xff }
  const rgb = encodeHierarchicalCells(base, enhancement, spec)
  const n = spec.gridW * spec.gridH
  const lum = new Float32Array(n), rel = new Float32Array(n).fill(1), empty = new Float32Array(0)
  for (let i = 0; i < n; i++) lum[i] = rgb[i * 3]
  const llr = softDemodHierarchical({ r: empty, g: empty, b: empty, lum, rel }, spec)
  for (let i = 0; i < layout.capacity * 8; i++) {
    const b0 = (base[i >> 3] >> (7 - (i & 7))) & 1
    const b1 = (enhancement[i >> 3] >> (7 - (i & 7))) & 1
    assert.ok(b0 ? llr.base[i] < 0 : llr.base[i] > 0)
    assert.ok(b1 ? llr.enhancement[i] < 0 : llr.enhancement[i] > 0)
  }
  assert.deepEqual(hierarchicalSeeds(5, 0), { base: 1, enhancement: 2 })
  assert.deepEqual(hierarchicalSeeds(5, 2), { base: 5, enhancement: 7 })
})

test('spatial equalizer reduces controlled BW neighbour blur without touching the barcode', () => {
  const spec: EncodingSpec = { enc: 'bw', gridW: 64, gridH: 64 }
  const n = spec.gridW * spec.gridH, first = spec.gridW * 3
  const clean = new Float32Array(n), seen = new Float32Array(n), rel = new Float32Array(n).fill(1), empty = new Float32Array(0)
  let seed = 0x12345678
  // Use a high LCG bit: the low bit of a power-of-two LCG has period 2, which
  // makes a 1-cell vertical stripe (horizontal anti-correlation cancels vertical
  // correlation → rho≈0), so blur would be undetectable. A whitened bit gives a
  // genuinely random field where isotropic blur shows up as positive correlation.
  for (let i = first; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; clean[i] = (seed >>> 16) & 1 ? 255 : 0 }
  for (let y = 0; y < spec.gridH; y++) for (let x = 0; x < spec.gridW; x++) {
    const i = y * spec.gridW + x
    if (i < first || x === 0 || x + 1 === spec.gridW || y === 0 || y + 1 === spec.gridH) { seen[i] = clean[i]; continue }
    seen[i] = clean[i] * 0.68 + (clean[i - 1] + clean[i + 1] + clean[i - spec.gridW] + clean[i + spec.gridW]) * 0.08
  }
  const got = equalizeSpatialReadings({ r: empty, g: empty, b: empty, lum: seen, rel }, spec)
  let before = 0, after = 0, count = 0
  for (let y = 4; y < spec.gridH - 1; y++) for (let x = 1; x < spec.gridW - 1; x++) {
    const i = y * spec.gridW + x
    before += (seen[i] - clean[i]) ** 2; after += (got.lum[i] - clean[i]) ** 2; count++
  }
  assert.ok(after / count < before / count)
  assert.equal(got.lum[0], seen[0])
})

test('super-resolution fuses sub-pixel-shifted looks into a sharper grid', () => {
  const W = 48, H = 48, from = W * 3, n = W * H
  let s = 0x1234abcd
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd())
  const clean = new Float32Array(n)
  for (let i = from; i < n; i++) clean[i] = rnd() < 0.5 ? 255 : 0
  // Build N sub-pixel-shifted, blurred, noisy looks of the same grid.
  const sample = (x: number, y: number) => {
    x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y))
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - x0, fy = y - y0
    return clean[y0 * W + x0] * (1 - fx) * (1 - fy) + clean[y0 * W + x1] * fx * (1 - fy) + clean[y1 * W + x0] * (1 - fx) * fy + clean[y1 * W + x1] * fx * fy
  }
  const looks: Float32Array[] = []
  for (let k = 0; k < 5; k++) {
    const dx = k === 0 ? 0 : (rnd() * 2 - 1) * 0.5, dy = k === 0 ? 0 : (rnd() * 2 - 1) * 0.5
    const Y = new Float32Array(n)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (i < from) { Y[i] = clean[i]; continue }
      // shifted + box-ish blur + noise
      const c = sample(x + dx, y + dy)
      const nb = (sample(x + dx - 1, y + dy) + sample(x + dx + 1, y + dy) + sample(x + dx, y + dy - 1) + sample(x + dx, y + dy + 1)) * 0.25
      Y[i] = c * 0.5 + nb * 0.5 + gauss() * 6
    }
    looks.push(Y)
  }
  const fused = fuseLooks(looks, W, H, from, { sigma: 0.75, iters: 20 })
  let mseSingle = 0, mseFused = 0, count = 0
  for (let y = 4; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    mseSingle += (looks[0][i] - clean[i]) ** 2; mseFused += (fused[i] - clean[i]) ** 2; count++
  }
  assert.ok(mseFused < mseSingle * 0.7, `fusion should sharpen (single ${(mseSingle / count) | 0} → fused ${(mseFused / count) | 0})`)
  // The shift estimator recovers a known sub-pixel offset it is given.
  const shifted = new Float32Array(n)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) shifted[y * W + x] = y < 3 ? clean[y * W + x] : sample(x + 0.3, y - 0.2)
  // Estimator returns the shift mapping ref→tgt (opposite sign to the content move).
  const [ex, ey] = estimateSubpixelShift(clean, shifted, W, H, from)
  assert.ok(Math.abs(ex + 0.3) < 0.12 && Math.abs(ey - 0.2) < 0.12, `estimated shift (${ex.toFixed(2)},${ey.toFixed(2)}) recovers the 0.3,-0.2 content move`)
})

test('systematic fountain frames reconstruct an out-of-order transfer', () => {
  const chunks = Array.from({ length: 8 }, (_, i) => Uint8Array.from([i, i + 10, i + 20]))
  const decoder = new FountainDecoder(chunks.length, 3)
  for (const seed of [5, 2, 8, 1, 7, 3, 6, 4]) decoder.addFrame(seed, chunks[seed - 1])
  assert.equal(decoder.isComplete, true)
  assert.deepEqual([...decoder.reconstruct()], [...chunks.flatMap(chunk => [...chunk])])
  assert.deepEqual(indicesForSeed(3, 8), [2])
})

test('Fast 8-direct fountain cadence reconstructs with interleaved repair frames', () => {
  const k = 53, chunk = 3
  const chunks = Array.from({ length: k }, (_, i) => Uint8Array.from([i, i ^ 0x5a, i ^ 0xa5]))
  const decoder = new FountainDecoder(k, chunk)
  for (let tick = 0; tick < k * 3 && !decoder.isComplete; tick++) {
    const seed = seedForDataIndex(tick, k, 8)
    decoder.addFrame(seed, fountainEncode(chunks, seed, chunk))
  }
  assert.equal(decoder.isComplete, true)
  assert.deepEqual([...decoder.reconstruct()], [...chunks.flatMap(part => [...part])])
})

test('bounded dense tail solver closes entangled repair equations', () => {
  const k = 40, chunk = 4
  const chunks = Array.from({ length: k }, (_, i) => Uint8Array.from([i, i ^ 0x21, i ^ 0x8e, i ^ 0xf0]))
  const decoder = new FountainDecoder(k, chunk)
  // Simulate a clean start with a small patterned loss, then feed repair frames.
  const missing = new Set([2, 7, 13, 18, 24, 31, 37])
  for (let i = 0; i < k; i++) if (!missing.has(i)) decoder.addFrame(i + 1, chunks[i])
  for (let repair = 1; repair < 360 && !decoder.isComplete; repair++) {
    const seed = k + repair
    decoder.addFrame(seed, fountainEncode(chunks, seed, chunk))
  }
  assert.equal(decoder.isComplete, true)
  assert.deepEqual([...decoder.reconstruct()], [...chunks.flatMap(part => [...part])])
})

test('fountain repair schedule includes a bounded tail-repair equation', () => {
  const k = 481
  assert.equal(indicesForSeed(k + 4, k).length, 32)
  assert.notEqual(indicesForSeed(k + 4, k, false).length, 32)
})

test('v4 repair cadence gives every second repair a medium-wide equation', () => {
  const k = 481
  assert.equal(indicesForSeed(k + 2, k, true, 2).length, 32)
  assert.notEqual(indicesForSeed(k + 3, k, true, 2).length, 32)
})

test('v5 binary manifest round-trips without JSON metadata', () => {
  const manifest: TransferManifest = {
    v: 5, id: 42, kind: 'file', name: 'sample.pdf', mime: 'application/pdf',
    total: 416638, comp: 415620, compressed: true, sha256: 'a'.repeat(64),
    k: 461, chunk: 902, enc: 'color8', gridW: 64, gridH: 64, rate: 0.625, fps: 6.5,
  }
  const wire = encodeManifestWire(manifest)
  assert.ok(wire.length < new TextEncoder().encode(JSON.stringify(manifest)).length)
  assert.deepEqual(decodeManifestWire(wire), manifest)
})

test('v6 manifest takes optical settings from the barcode lock', () => {
  const manifest: TransferManifest = {
    v: 6, id: 42, kind: 'file', name: 'sample.pdf', mime: 'application/pdf',
    total: 416638, comp: 415620, compressed: true, sha256: 'a'.repeat(64),
    k: 461, chunk: 902, enc: 'color8', gridW: 64, gridH: 64, rate: 0.625, fps: 6.5,
  }
  const wire = encodeManifestWire(manifest)
  assert.equal(decodeManifestWire(wire), null)
  assert.deepEqual(decodeManifestWire(wire, { enc: 'color8', gridW: 64, gridH: 64, rate: 0.625 }), manifest)
})

test('v8 fountain cadence improves deterministic Turbo paired loss while v7 stays compatible', () => {
  const completionCaptures = (mediumWideEvery: number) => {
    const k = 461
    const decoder = new FountainDecoder(k, 1, true, mediumWideEvery)
    let captures = 0
    while (!decoder.isComplete && captures < 1200) {
      // 9 sender ticks sampled by a measured ~7.37 pair-decodes/s receiver.
      // Both adjacent lanes are skipped together; the patterned 10% decode loss
      // reproduces the non-IID field shape that exposed the w1 regression.
      const senderTick = Math.floor(captures * 9 / 7.37)
      for (const dataIndex of [senderTick * 2, senderTick * 2 + 1]) {
        if ((dataIndex * 17 + 13) % 100 >= 10)
          decoder.addFrame(seedForDataIndex(dataIndex, k, 8), new Uint8Array(1))
      }
      captures++
    }
    return { complete: decoder.isComplete, captures }
  }
  const robust = completionCaptures(2)
  const packedTail = completionCaptures(1)
  assert.equal(robust.complete, true)
  assert.ok(robust.captures < 400, `paired-loss mapping should close promptly (${robust.captures})`)
  assert.equal(packedTail.complete, true)
  assert.ok(packedTail.captures < robust.captures,
    `v8 wide repairs should close before v7 (${packedTail.captures} vs ${robust.captures})`)
})

test('v7 compact manifest round-trips with barcode optical settings', () => {
  const manifest: TransferManifest = {
    v: 7, id: 43, kind: 'file', name: 'sample.pdf', mime: 'application/pdf',
    total: 416638, comp: 415620, compressed: true, sha256: 'c'.repeat(64),
    k: 461, chunk: 902, enc: 'color8', gridW: 64, gridH: 64, rate: 0.625, fps: 9,
  }
  const wire = encodeManifestWire(manifest)
  assert.deepEqual(decodeManifestWire(wire, { enc: 'color8', gridW: 64, gridH: 64, rate: 0.625 }), manifest)
})

test('v8 compact manifest selects the packed-tail repair protocol', () => {
  const manifest: TransferManifest = {
    v: 8, id: 44, kind: 'file', name: 'sample.pdf', mime: 'application/pdf',
    total: 416638, comp: 415620, compressed: true, sha256: 'd'.repeat(64),
    k: 461, chunk: 902, enc: 'color8', gridW: 64, gridH: 64, rate: 0.625, fps: 12,
  }
  const wire = encodeManifestWire(manifest)
  assert.deepEqual(decodeManifestWire(wire, { enc: 'color8', gridW: 64, gridH: 64, rate: 0.625 }), manifest)
})

test('v9 compact manifest selects the field-proven mixed repair protocol', () => {
  const manifest: TransferManifest = {
    v: 9, id: 45, kind: 'file', name: 'sample.pdf', mime: 'application/pdf',
    total: 416638, comp: 415620, compressed: true, sha256: 'e'.repeat(64),
    k: 461, chunk: 902, enc: 'color8', gridW: 64, gridH: 64, rate: 0.625, fps: 12,
  }
  const wire = encodeManifestWire(manifest)
  assert.deepEqual(decodeManifestWire(wire, { enc: 'color8', gridW: 64, gridH: 64, rate: 0.625 }), manifest)
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) => seedForDataIndex(index, manifest.k, 8)),
    [1, 2, 3, 4, 5, 6, 7, 8, 462, 9],
  )
})

test('robust bootstrap manifest may use a lower LDPC rate than its payload', () => {
  const manifest: TransferManifest = {
    v: 5, id: 91, kind: 'file', name: 'bw.pdf', mime: 'application/pdf',
    total: 416638, comp: 415620, compressed: true, sha256: 'b'.repeat(64),
    k: 300, chunk: 1387, enc: 'bw', gridW: 128, gridH: 128, rate: 0.7, fps: 10,
  }
  const capacity = 2000
  const frame = encodeManifestFrames(manifest, capacity, 0.6)[0]!
  // expand bytes to one LLR per transmitted bit (positive means transmitted 0).
  const bits = new Float64Array(capacity * 8)
  for (let i = 0; i < frame.length; i++) for (let b = 0; b < 8; b++) bits[i * 8 + b] = ((frame[i] >> (7 - b)) & 1) ? -12 : 12
  const parsed = parseFrameLdpcSoft(bits, capacity, 0.6)
  assert.ok(parsed)
  assert.equal(parsed!.type, 0)
  assert.deepEqual(decodeManifestWire(parsed!.payload.subarray(2)), manifest)
})
