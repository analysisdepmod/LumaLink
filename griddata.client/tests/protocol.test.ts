import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeBarcodeRow, encodeBarcodeRow } from '../src/services/metaBarcode.ts'
import { FountainDecoder } from '../src/services/fountainDecoder.ts'
import { indicesForSeed } from '../src/services/fountainDecoder.ts'
import { decodeManifestWire, encodeManifestFrames, encodeManifestWire, fountainEncode, packFrameLdpc, parseFrameLdpcSoft, seedForDataIndex, type TransferManifest } from '../src/services/transferCodec.ts'
import { capacityBytes, encodeCellsRGB, equalizeSpatialReadings, softDemodLLR, type EncodingSpec } from '../src/services/visualCodec.ts'
import { encodeHierarchicalCells, hierarchicalLayout, hierarchicalSeeds, softDemodHierarchical } from '../src/services/hierarchicalCodec.ts'
import { estimateSubpixelShift, fuseLooks } from '../src/services/superReceiver.ts'
import { homographyCoefficients } from '../src/services/webGpuGridSampler.ts'

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
