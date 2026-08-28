// Off-main-thread decode pipeline with barcode-first spec detection.
//
// The heavy per-frame work — grid registration, soft colour demod + 3×3 MIMO
// un-mix, and LDPC belief propagation — runs here so the camera never stalls.
//
// BARCODE DETECTION: row 0 of the grid carries a B&W barcode encoding the
// sender's spec (enc, rate, zones, ringWidth). The receiver tries candidate
// gridW values, derives gridH from the quad's pixel aspect ratio, and reads
// row 0 with a CRC-8 check — near-instantaneous vs the old approach that ran
// full LDPC decodes per candidate.

import { locateMatrix, locateMatrixHeld, locateMatrixTracked, sampleMapped, sampleMappedBinary, sampleBarcodeLum, type GridMap, type Corners, type TrackState, type Located } from './matrixVision'
import { equalizeSpatialReadings, estimateSpatialBlur, setSpatialSimd, softDemodLLR, softDemodLLRZoned, capacityBytes, capacityBytesZoned, type CellReadings, type Encoding, type EncodingSpec, type ZoneMap } from './visualCodec'
import { SoftReceiver } from './softReceiver'
import { SuperReceiver } from './superReceiver'
import { parseFrameLdpcSoft, specFromManifest, zoneMapFromManifest, type ParsedFrame, type TransferManifest } from './transferCodec'
import { buildZoneMap, isMultiZone } from './adaptiveZones'
import { setBpDecoder } from './ldpc'
import { loadLdpcWasm } from './ldpcWasm'
import { loadSpatialSimd } from './spatialSimdWasm'
import { BARCODE_VERSION, BARCODE_ROWS, decodeBarcodeRow } from './metaBarcode'
import { WebGpuGridSampler } from './webGpuGridSampler'

let wasmActive = false
let spatialSimdActive = false
loadLdpcWasm().then(w => { if (w) { setBpDecoder((code, llr, iters) => w.decode(code, llr, iters)); wasmActive = true } }).catch(() => {})
// The spatial filter is independent from LDPC WASM.  A SIMD-capable browser
// moves the dense 128×128 equalizer into WebAssembly; unsupported phones keep
// the safe scalar filter without affecting protocol compatibility.
// SIMD has an identical scalar fallback; use it where it pays off (dense grids)
// while keeping unsupported browsers protocol-compatible.
const ENABLE_EXPERIMENTAL_SPATIAL_SIMD = true
if (ENABLE_EXPERIMENTAL_SPATIAL_SIMD) loadSpatialSimd().then(w => {
  setSpatialSimd(w)
  spatialSimdActive = !!w
}).catch(() => {})

interface DecodeRequest {
  pixels?: ArrayBuffer
  bitmap?: ImageBitmap
  w: number
  h: number
  auto: boolean
  spec?: EncodingSpec
  manifest?: TransferManifest
  reset?: boolean
  id: number
}
interface DecodeReply {
  id: number
  result: ParsedFrame | null
  found: boolean
  looks: number
  combinedWins: number
  lockedSpec?: EncodingSpec
  /** Number of fixed visual lanes advertised by the metadata strip. */
  lanes?: 1 | 2
  ms: number
  wasm: boolean
  /** Dense spatial equalizer is backed by WASM SIMD on this worker. */
  spatialSimd?: boolean
  /** Grid-cell sampling ran in a WebGPU compute pipeline. */
  webGpu?: boolean
  /** GPU dispatch + compact cell-buffer readback time. */
  gpuSampleMs?: number
  dark: boolean
  tracked?: boolean
  /** Receiver state: full acquisition or fast homography-tracked payload. */
  phase?: 'search' | 'bootstrap' | 'payload'
  /** Mean per-cell optical confidence after sampling, 0..1. */
  colorConfidence?: number
  /** Dense-BW super-resolution rescue telemetry. */
  superLooks?: number
  superWins?: number
  /** Stable local estimate of optical neighbour spill / MTF loss, 0..0.34. */
  spatialBlur?: number
  // Outer finder-frame corners of the located matrix, normalised to [0,1] of the
  // processed frame (x/w, y/h). Present whenever a matrix was found this frame so
  // the UI can draw tracking brackets that hug the tile. Undefined ⇒ nothing seen.
  quad?: NormQuad
}

/** A quad with each corner normalised to [0,1] of the frame it was found in. */
export interface NormQuad { tl: Pt; tr: Pt; br: Pt; bl: Pt }
interface Pt { x: number; y: number }

// Candidate gridW values for barcode-first detection. The sender derives its grid
// from its own screen (any multiple of 8), so the receiver cannot assume a fixed
// size — it enumerates ALL plausible multiples of 8 and, for each, samples ONLY
// row 0 (cheap) and checks the metadata barcode's CRC. gridH is derived from the
// quad's pixel aspect ratio. Row-0 probing is so light we can try every width per
// frame, so an arbitrary rectangular grid still locks in a single good capture.
const GRID_WIDTHS: number[] = []
for (let w = 40; w <= 256; w += 8) GRID_WIDTHS.push(w)
// Covers the largest sender presets, including the 256×256 high-density option
// (65 536 cells). The barcode probe only samples BARCODE_ROWS rows so it's cheap
// even for big candidates; the exact gridH from the barcode then bounds the one
// full decode we run on the winning width.
const MAX_DETECT_CELLS = 66000

// LDPC fallback candidates (for senders without barcode or when barcode fails)
const ENCS: Encoding[] = ['color64', 'color32', 'color16', 'color8', 'bw']
const GRID_DIMS: { w: number; h: number }[] = [
  { w: 96, h: 96 }, { w: 64, h: 64 }, { w: 32, h: 32 },
  { w: 160, h: 160 }, { w: 128, h: 128 }, { w: 16, h: 16 },
  { w: 160, h: 88 }, { w: 120, h: 64 }, { w: 192, h: 104 },
  { w: 88, h: 160 }, { w: 104, h: 192 }, { w: 48, h: 80 },
  { w: 160, h: 96 }, { w: 96, h: 160 },
  // NOTE: 256×256 is deliberately NOT a brute-force candidate. Blindly running a
  // full 65 k-cell LDPC decode on every wrong-spec frame (×pool of workers) pegs
  // the CPU and can crash the tab. The barcode-first path still locks a real
  // 256×256 sender (GRID_WIDTHS covers it) — it only decodes once the barcode CRC
  // actually confirms that width, so the heavy decode runs only when it can win.
]
const RATES = [0.6, 0.625, 0.65, 0.675, 0.7, 0.75]
const CANDIDATES: EncodingSpec[] = []
for (const rate of RATES) for (const enc of ENCS) for (const g of GRID_DIMS) CANDIDATES.push({ enc, gridW: g.w, gridH: g.h, rate })
const FALLBACK_BUDGET = 3

function deriveGridH(map: GridMap, gridW: number): number {
  const tl = map(0, 0), tr = map(1, 0), bl = map(0, 1), br = map(1, 1)
  const pw = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2
  const ph = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2
  const cellPx = pw / gridW
  return Math.max(BARCODE_ROWS + 1, Math.round(ph / cellPx))
}

let rx: SoftReceiver | null = null
// SR is deliberately a BW-only rescue path. It is invoked only after the normal
// equalizer + soft-combiner has failed, and only for dense grids where sub-pixel
// diversity can recover information the single-look path cannot.
let superRx: SuperReceiver | null = null
let superKey = ''
let superFusedLooks = 0
let superWins = 0
let locked: EncodingSpec | null = null
let lockedZm: ZoneMap | null = null
// `locked` begins with the robust bootstrap rate from the barcode. Once the
// manifest arrives we atomically replace it with the actual payload spec/rate.
let lockedTransferId: number | null = null
let fCursor = 0
// Barcode lock needs one confirmation: sync+CRC give ~16 bits of validation, but
// across every width/phase/offset probed each frame a stray match is still
// possible. Requiring the SAME (enc,gridW,gridH) barcode on two frames — unless a
// full LDPC decode already vouched for it — makes a false lock essentially
// impossible while a real barcode (100% read under realistic blur) confirms in 2 frames.
let pendingKey = ''
let pendingCount = 0
// Self-healing: if a lock is wrong (bad barcode read that slipped confirmation),
// every subsequent frame fails to decode. After this many consecutive locked
// frames with zero successful decodes, drop the lock and re-search from scratch.
// Raised 45→150: a CORRECT lock on a marginal handheld channel can go many frames
// between full closes (the temporal combiner needs looks to stack up), and dropping
// it there triggers an expensive re-search — the main source of the 100→2500 ms
// per-frame jitter and the "connection keeps dropping" feel. 150 dry frames is still
// a clear sign of a genuinely wrong lock, but no longer punishes a slow-but-correct one.
let sinceProgress = 0
const RELOCK_AFTER = 150
// Our sender ALWAYS paints the metadata barcode, so once we've read one this session
// the barcode-first path owns detection. The brute-force LDPC fallback (full BP over
// several wrong candidate specs per frame — each building a code and running belief
// propagation) then only burns CPU and causes multi-second stalls during any
// re-acquisition. Gate it off after the first barcode sighting.
let barcodeSeen = false

// Adaptive CV lock. It is enabled only after several decoded refined frames.
// Handheld camera exposure/AF regularly gives a one- or two-frame weak read;
// that must not make the visible state flap between Payload and Bootstrap.
let trackState: TrackState | null = null
let trackingReady = false
let trackingGood = 0
let trackedFailures = 0
let trackVelocity: { x: number; y: number }[] | null = null
let heldMapFrames = 0
function noteTrack(located: Located | null, usedTracked: boolean, decoded: boolean): void {
  if (decoded && located?.track) {
    heldMapFrames = 0
    if (trackState) {
      trackVelocity = located.track.centers.map((p, i) => {
        const old = trackState!.centers[i]
        const prev = trackVelocity?.[i] ?? { x: 0, y: 0 }
        return { x: prev.x * 0.55 + (p.x - old.x) * 0.45, y: prev.y * 0.55 + (p.y - old.y) * 0.45 }
      })
    }
    trackState = located.track; trackedFailures = 0
    if (!trackingReady && ++trackingGood >= 8) trackingReady = true
    return
  }
  if (usedTracked && !decoded && ++trackedFailures >= 6) {
    trackState = null; trackVelocity = null; trackingReady = false; trackingGood = 0; trackedFailures = 0
  }
}

let offCanvas: OffscreenCanvas | null = null
let offCtx: OffscreenCanvasRenderingContext2D | null = null
const webGpuSamplerPromise = WebGpuGridSampler.create()
let webGpuSampler: WebGpuGridSampler | null = null
let gpuFrameReady = false
let gpuValidated = false
let gpuDisabled = false
let gpuValidationKey = ''
let gpuFlipY = false

let t0 = 0
let curDark = false
let curQuad: NormQuad | undefined
let curTracked = false
let curPhase: 'search' | 'bootstrap' | 'payload' = 'search'
let curColorConfidence: number | undefined
let curSpatialBlur: number | undefined
let curWebGpu = false
let curGpuSampleMs: number | undefined

// A single fountain frame is intentionally noise-like, therefore its neighbour
// correlation is a useful instantaneous MTF/blur observation.  Smooth it across
// frames so exposure flicker or one unusual payload cannot make the inverse
// filter pump from frame to frame. The state is private to this worker; a lock
// change resets it, so calibration never leaks between displays/transfers.
let mtfKey = ''
let mtfBlur = 0
let mtfSamples = 0
function calibratedSpatialBlur(rd: Parameters<typeof estimateSpatialBlur>[0], spec: EncodingSpec): number {
  const key = `${spec.enc}:${spec.gridW}x${spec.gridH}`
  if (key !== mtfKey) { mtfKey = key; mtfBlur = 0; mtfSamples = 0 }
  const instant = estimateSpatialBlur(rd, spec)
  const alpha = mtfSamples < 8 ? 0.30 : 0.075
  mtfBlur = mtfSamples === 0 ? instant : mtfBlur + (instant - mtfBlur) * alpha
  mtfSamples++
  return mtfBlur
}
function resetSpatialCalibration(): void { mtfKey = ''; mtfBlur = 0; mtfSamples = 0 }

function resetGpuValidation(): void {
  gpuValidated = false
  gpuDisabled = false
  gpuValidationKey = ''
  gpuFlipY = false
}

/**
 * Pearson agreement on a bounded luminance sample.  This is enough to choose
 * the external-texture Y convention because payload cells are deliberately
 * noise-like, while avoiding a second LDPC decode during GPU start-up.
 */
function luminanceAgreement(a: CellReadings, b: CellReadings): number {
  const n = Math.min(a.lum.length, b.lum.length)
  if (n < 2) return -1
  const step = Math.max(1, Math.floor(n / 2048))
  let count = 0, sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0
  for (let i = 0; i < n; i += step) {
    const av = a.lum[i], bv = b.lum[i]
    count++; sumA += av; sumB += bv
    sumAA += av * av; sumBB += bv * bv; sumAB += av * bv
  }
  const cov = sumAB - sumA * sumB / count
  const varA = sumAA - sumA * sumA / count
  const varB = sumBB - sumB * sumB / count
  return cov / Math.sqrt(Math.max(1e-9, varA * varB))
}

function superFor(spec: EncodingSpec): SuperReceiver | null {
  if (spec.enc !== 'bw' || spec.gridW * spec.gridH < 10000) return null
  const key = `${spec.gridW}x${spec.gridH}`
  if (!superRx || superKey !== key) {
    superRx = new SuperReceiver(spec.gridW, spec.gridH, spec.gridW * BARCODE_ROWS, 5)
    superKey = key
    superFusedLooks = 0
  }
  return superRx
}
self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { pixels, bitmap, w, h, auto, spec, manifest, reset, id } = e.data
  t0 = performance.now()
  curQuad = undefined
  curTracked = false
  curPhase = 'search'
  curColorConfidence = undefined
  curSpatialBlur = undefined
  curWebGpu = false
  curGpuSampleMs = undefined
  try {
    if (reset) { locked = null; lockedZm = null; lockedTransferId = null; rx = null; superRx = null; superKey = ''; superFusedLooks = 0; superWins = 0; resetSpatialCalibration(); resetGpuValidation(); fCursor = 0; pendingKey = ''; pendingCount = 0; sinceProgress = 0; barcodeSeen = false; trackState = null; trackVelocity = null; heldMapFrames = 0; trackingReady = false; trackingGood = 0; trackedFailures = 0 }
    // Once any worker has decoded the manifest, CameraReader forwards it to the
    // whole pool. Lock every worker directly from that authoritative spec: data
    // frames deliberately carry no barcode, so they remain untouched LDPC payload.
    if (manifest && lockedTransferId !== manifest.id) {
      const nextLocked = specFromManifest(manifest)
      const nextZm = zoneMapFromManifest(manifest)
      const changed = !locked || locked.enc !== nextLocked.enc || locked.gridW !== nextLocked.gridW || locked.gridH !== nextLocked.gridH || locked.rate !== nextLocked.rate || !!lockedZm !== !!nextZm
      locked = nextLocked
      lockedZm = nextZm
      lockedTransferId = manifest.id
      if (changed) {
        rx = null
        superRx = null; superKey = ''; superFusedLooks = 0
        resetSpatialCalibration()
        resetGpuValidation()
      }
      barcodeSeen = true
      pendingKey = ''; pendingCount = 0; sinceProgress = 0
    } else if (manifest && !lockedZm) {
      lockedZm = zoneMapFromManifest(manifest)
    }

    let px: Uint8ClampedArray
    if (bitmap) {
      // Upload before closing the transferable ImageBitmap. WebGPU retains the
      // camera frame as a texture; the CPU readback remains temporarily for the
      // proven finder/registration path, while steady-state cell sampling moves
      // to the parallel compute shader below.
      // Do not spend a GPU upload while the barcode search still owns the frame;
      // the shader pays off only after a concrete grid is known.
      // In auto mode the bootstrap manifest must stay on the proven CPU sampler.
      // WebGPU enters only after another worker has decoded and broadcast the
      // authoritative manifest, then it must pass the shadow comparison below.
      const gpuSpec = auto ? (lockedTransferId != null ? locked : null) : spec
      if (gpuSpec && webGpuSampler === null) webGpuSampler = await webGpuSamplerPromise
      gpuFrameReady = !!gpuSpec && !!webGpuSampler?.upload(bitmap, w, h)
      if (!offCanvas || offCanvas.width !== w || offCanvas.height !== h) {
        offCanvas = new OffscreenCanvas(w, h)
        offCtx = offCanvas.getContext('2d', { willReadFrequently: true })
      }
      offCtx!.drawImage(bitmap, 0, 0, w, h)
      px = offCtx!.getImageData(0, 0, w, h).data
      bitmap.close()
    } else {
      gpuFrameReady = false
      px = new Uint8ClampedArray(pixels!)
    }
    { let s = 0, c = 0; const b = ((h >> 1) * w + (w >> 1)) * 4; for (let i = -32; i <= 32; i += 4) { const p = b + i * 4; s += px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114; c++ } curDark = s / c < 6 }
    // Full detection every frame. The tracked fast-path (re-pinning finders around
    // last frame's centres) was a big win for a STATIC propped scene, but on a
    // hand-held receiver it pinned slightly-drifted maps between frames → the decode
    // failed → BP ran every frame → the scan rate collapsed to a few fps. A fresh
    // full locate each frame is a few ms more but gives an accurate map every time,
    // so clean captures close on the cheap fast path (high fps). (`locateMatrixTracked`
    // is kept in matrixVision for a future static-mode opt-in.)
    // The tracked fast-path (re-pin finders around last frame's predicted centres)
    // MUST stay off for a hand-held receiver: once tracking goes "ready" (8 decoded
    // frames) it pins a slightly-drifted map between frames, the sample lands off the
    // true cells, and decode then fails persistently — the map drift compounds across
    // the transfer, which is exactly the "stalls after ~N chunks and the brackets
    // vanish" field failure. Full detection every frame costs a few ms more but gives
    // an accurate map every time (clean captures still close on the cheap fast path).
    // The flag is kept so a propped/static mode can opt back in later.
    // Keep prediction disabled on the live hand-held path. Local-threshold finder
    // refinement improved acquisition, but it does not make a predicted window
    // immune to accumulated sub-cell drift on 96/128 grids. Full locate still uses
    // the new scale-invariant finder implementation, MTF equalisation and SIMD; only
    // the unsafe reuse of previous geometry is disabled.
    const USE_TRACKED_PREDICTION = false
    let usedTracked = false
    let heldMap = false
    const predictedTrack = USE_TRACKED_PREDICTION && trackingReady && trackState
      ? { ...trackState, centers: trackState.centers.map((p, i) => ({ x: p.x + (trackVelocity?.[i]?.x ?? 0), y: p.y + (trackVelocity?.[i]?.y ?? 0) })) as TrackState['centers'] }
      : null
    let located = predictedTrack ? locateMatrixTracked(px, w, h, predictedTrack) : null
    if (located) usedTracked = true
    if (!located) located = locateMatrix(px, w, h)
    // If autofocus/exposure drops the static finders for a few captures, keep
    // sampling the last calibrated homography instead of dropping the transfer.
    // A fresh locate is still attempted first on every frame; the hold is capped
    // so a real camera re-aim can never remain falsely locked indefinitely.
    // Held-map DISABLED. It re-served the LAST finder fit (trackState) whenever a
    // fresh locate failed — but trackState is only kept in the CV-Lock (payload)
    // phase, so when a tilted / near-full-frame capture made the coarse quad fail
    // there, it froze the bracket on that last (already-grown) fit and kept sampling
    // a stale map: exactly the field report "in bootstrap the bracket resizes to fit,
    // after CV-Lock it grows and stops resizing". Better to drop the frame and locate
    // fresh next capture than to decode through a stale, grown map.
    const USE_HELD_MAP = false
    if (USE_HELD_MAP && !located && trackState && heldMapFrames < 6) {
      located = locateMatrixHeld(trackState)
      usedTracked = true
      heldMap = true
      heldMapFrames++
    }
    if (!located) { noteTrack(null, usedTracked, false); reply({ id, result: null, found: false, looks: 0, combinedWins: 0 }); return }
    if (!heldMap) heldMapFrames = 0
    curTracked = usedTracked
    // `usedTracked` describes just THIS capture. Keep the phase locked through
    // short fallback-to-full-locator gaps; the actual tracked state is dropped
    // only by noteTrack after sustained failed tracked decodes.
    curPhase = trackingReady && trackState ? 'payload' : 'bootstrap'
    const map = located.map
    // Surface the tracking quad only on FINDER-REFINED frames (accurate corners),
    // never the coarse geometric fallback — a geometric quad can jump to the wrong
    // size and makes the brackets jitter. The tracked fast path returns a refined
    // fit on almost every frame once locked, so the brackets stay continuously lit
    // (bridged across the rare gap by the CameraReader's HOLD window) without ever
    // drawing a bad box.
    if (located.refined) curQuad = normQuad(located.outer, w, h)

    const known = auto ? locked : (spec ?? null)
    if (known) {
      const cap = lockedZm ? capacityBytesZoned(lockedZm) : capacityBytes(known)
      // Before the manifest, dense BW must attempt BP on the first capture. The
      // former defer=true setting could stay forever at look 1 under slight phone
      // motion and therefore never execute LDPC. After K is known, defer the costly
      // payload BP again because independent fountain frames favour throughput.
      if (!rx) {
        const denseBw = known.enc === 'bw' && known.gridW * known.gridH >= 10000
        // CameraReader distributes native 128² payload frames over several
        // workers. A worker therefore usually sees a NEW fountain frame on its
        // next turn, not a repeat of the previous one. Deferring BP until a repeat
        // deadlocks all three workers at look 1 and yields 0/K forever.
        rx = new SoftReceiver(cap, known.rate ?? 0.6, denseBw ? 12 : 24, false)
      }
      const cpuSample = (): CellReadings => known.enc === 'bw'
        ? sampleMappedBinary(px, w, h, map, known.gridW, known.gridH)
        : sampleMapped(px, w, h, map, known.gridW, known.gridH)
      const validationKey = `${known.enc}:${known.gridW}x${known.gridH}`
      if (gpuValidationKey && gpuValidationKey !== validationKey) resetGpuValidation()
      if (!gpuValidationKey) gpuValidationKey = validationKey
      let rawReadings: CellReadings | null = null
      if (!gpuDisabled && gpuFrameReady && webGpuSampler) {
        let gpu = await webGpuSampler.sample(located.inner, known.gridW, known.gridH, known.enc === 'bw', gpuFlipY)
        if (gpu) {
          curGpuSampleMs = gpu.ms
          if (!gpuValidated) {
            // Calibrate only once and never run LDPC twice for one exposure. The
            // old CRC probe doubled the dominant decoder cost on every Turbo lane
            // for up to 12 frames, making the whole transfer feel heavier. Compare
            // a bounded luminance sample against the CPU coordinates instead and
            // choose the texture orientation with the stronger correlation.
            const cpu = cpuSample()
            const normalScore = luminanceAgreement(cpu, gpu.readings)
            const flipped = await webGpuSampler.sample(located.inner, known.gridW, known.gridH, known.enc === 'bw', !gpuFlipY)
            const flippedScore = flipped ? luminanceAgreement(cpu, flipped.readings) : -1
            if (flipped && flippedScore > normalScore) {
              gpuFlipY = !gpuFlipY
              gpu = flipped
              curGpuSampleMs = gpu.ms
            }
            if (Math.max(normalScore, flippedScore) >= 0.72) {
              gpuValidated = true
              rawReadings = gpu.readings
              curWebGpu = true
            } else {
              rawReadings = cpu
              gpuDisabled = true
            }
          } else {
            rawReadings = gpu.readings
            curWebGpu = true
          }
        }
      }
      if (!rawReadings) rawReadings = cpuSample()
      curSpatialBlur = calibratedSpatialBlur(rawReadings, known)
      const readings = equalizeSpatialReadings(rawReadings, known, { strength: curSpatialBlur })
      curColorConfidence = meanReliability(readings.rel)
      const llr = lockedZm ? softDemodLLRZoned(readings, lockedZm) : softDemodLLR(readings, known)
      // Buffer only looks that the exact same SoftReceiver identity test regards
      // as one displayed frame. SR never participates on an already successful
      // ordinary decode, so it is strictly an additive rescue path.
      const sr = lockedZm ? null : superFor(known)
      const same = sr ? rx.sameFrame(llr) : false
      if (sr) {
        if (!same) { sr.reset(); superFusedLooks = 0 }
        sr.feed(rawReadings.lum)
      }
      let result = rx.feed(llr)
      if (!result && sr && sr.count >= 3 && sr.count !== superFusedLooks) {
        superFusedLooks = sr.count
        try {
          // SR itself is a multi-look deconvolver. Do not sharpen it again: that
          // would amplify ringing. A bounded 8-iteration min-sum attempt keeps
          // this exceptional path from turning into a worker stall.
          const fused = sr.fuse({ sigma: 0.7, iters: 8, mu: 0.85 })
          if (fused) {
            const fusedReadings = { ...rawReadings, lum: fused }
            const rescued = parseFrameLdpcSoft(softDemodLLR(fusedReadings, known), cap, known.rate ?? 0.6, false, 8)
            if (rescued) { result = rescued; superWins++ }
          }
        } catch { /* SR is opportunistic: preserve the normal decoder on any fault. */ }
      }
      noteTrack(located, usedTracked, !!result)
      // Auto-relock (auto mode only): a wrong auto-GUESSED lock never decodes, so a
      // long dry spell drops it and detection starts over. But a lock that came from
      // a decoded MANIFEST (lockedTransferId set) is correct by construction — a dry
      // spell there is just blur / a finder-refinement gap, NOT a wrong spec. Dropping
      // it forces re-acquisition on barcode-less mid-payload frames, which is exactly
      // where a hand-held transfer got permanently stuck (brackets vanish, ~N chunks
      // then dead). So NEVER auto-drop a manifest lock: keep the correct spec and the
      // fountain progress, and decoding resumes the moment the capture sharpens.
      if (auto) {
        if (result) sinceProgress = 0
        else if (lockedTransferId == null && ++sinceProgress >= RELOCK_AFTER) {
          locked = null; lockedZm = null; lockedTransferId = null; rx = null; superRx = null; superKey = ''; superFusedLooks = 0; resetSpatialCalibration(); sinceProgress = 0
          // Also drop the CV-tracking state (reset does this too): a relock means the
          // current lock is stale, so any tracked homography built under it is stale
          // and must not be carried into re-acquisition.
          trackState = null; trackVelocity = null; heldMapFrames = 0; trackingReady = false; trackingGood = 0; trackedFailures = 0
          pendingKey = ''; pendingCount = 0
          reply({ id, result: null, found: false, looks: 0, combinedWins: 0 })
          return
        }
      }
      reply({ id, result, found: true, looks: rx.looks, combinedWins: rx.combinedWins })
      return
    }

    // ── Barcode-first detection ──
    // Probe EVERY candidate width with a cheap row-0-only sample and check the
    // metadata barcode. Deriving gridH from geometry means any rectangular grid
    // the sender chose is found without guessing its height. The first width
    // whose barcode CRC passes wins.
    let hit: { spec: EncodingSpec; zm: ZoneMap | null; lanes: 1 | 2 } | null = null
    for (const gw of GRID_WIDTHS) {
      const ghApprox = deriveGridH(map, gw)
      if (gw * ghApprox > MAX_DETECT_CELLS) continue
      try {
        // Read the barcode STRIP (all BARCODE_ROWS rows averaged) at the geometry-
        // derived height — good enough to place row 0, since it's at the very top.
        const rowLum = sampleBarcodeLum(px, w, h, map, gw, ghApprox, BARCODE_ROWS)
        const bc = decodeBarcodeRow(rowLum, gw)
        if (!bc) continue
        if (bc.version !== BARCODE_VERSION) continue
        // A valid CRC alone is not enough: without an explicit width a barcode
        // sampled at the wrong grid density can alias into a false lock.
        if (bc.gridW !== 0 && bc.gridW !== gw) continue
        barcodeSeen = true // our sender always paints it → disables the heavy LDPC fallback
        // The barcode carries the EXACT gridH; geometry only approximated it.
        // Cross-check them: a genuine barcode's height agrees with the pixel
        // geometry, so a wild mismatch means a stray CRC match at the wrong
        // width — reject it. This is what kills the "read 8 as 64" false locks.
        const gh = (bc.gridH >= 8 && gw * bc.gridH <= MAX_DETECT_CELLS) ? bc.gridH : ghApprox
        const ratio = gh / Math.max(1, ghApprox)
        if (ratio < 0.6 || ratio > 1.7) continue
        const s: EncodingSpec = { enc: bc.enc, gridW: gw, gridH: gh, rate: bc.rate }
        const zm = (bc.zones && bc.enc !== 'bw') ? buildZoneMap(gw, gh, bc.enc, bc.ringWidth) : null
        hit = { spec: s, zm, lanes: bc.lanes ?? 1 }
        break
      } catch { /* sample error — skip this width */ }
    }
    if (hit) {
      const { spec: s, zm, lanes } = hit
      const key = `${s.enc}:${s.gridW}:${s.gridH}:${zm ? 'z' : ''}`
      try {
        const cap = zm ? capacityBytesZoned(zm) : capacityBytes(s)
        const rawReadings = s.enc === 'bw'
          ? sampleMappedBinary(px, w, h, map, s.gridW, s.gridH)
          : sampleMapped(px, w, h, map, s.gridW, s.gridH)
        const readings = equalizeSpatialReadings(rawReadings, s)
        curColorConfidence = meanReliability(readings.rel)
        const llr = zm ? softDemodLLRZoned(readings, zm) : softDemodLLR(readings, s)
        const parsed = parseFrameLdpcSoft(llr, cap, s.rate, true)
        if (parsed) {
          // Full frame decoded → spec is certainly correct: lock immediately.
          locked = s; lockedZm = zm; rx = new SoftReceiver(cap, s.rate, s.enc === 'bw' ? 12 : 24, false)
          pendingKey = ''; pendingCount = 0
          reply({ id, result: parsed, found: true, looks: 1, combinedWins: 0, lockedSpec: s, lanes })
          return
        }
        // Barcode CRC passed but the frame didn't decode yet (blur/motion). Lock
        // only after a second frame reports the same spec, to rule out a fluke.
        if (key === pendingKey) {
          pendingCount++
          if (pendingCount >= 2) {
            locked = s; lockedZm = zm; rx = new SoftReceiver(cap, s.rate, s.enc === 'bw' ? 12 : 24, false)
            reply({ id, result: null, found: true, looks: 1, combinedWins: 0, lockedSpec: s, lanes })
            return
          }
        } else { pendingKey = key; pendingCount = 1 }
        reply({ id, result: null, found: true, looks: 0, combinedWins: 0 })
        return
      } catch { /* sample error — fall through to LDPC search */ }
    }

    // LDPC fallback: try full decode on a few candidates (for senders without a
    // barcode). Skipped once we've ever read a barcode this session — our sender
    // always paints one, so this brute-force BP-over-wrong-specs path would only
    // stall re-acquisition for seconds. A frame that just missed the barcode (blur)
    // is better left for the next, clearer capture than fed to full BP here.
    if (barcodeSeen) { reply({ id, result: null, found: false, looks: 0, combinedWins: 0 }); return }
    for (let n = 0; n < FALLBACK_BUDGET; n++) {
      const cand = CANDIDATES[(fCursor + n) % CANDIDATES.length]
      if (cand.gridW * cand.gridH > MAX_DETECT_CELLS) continue
      try {
        const rawReadings = cand.enc === 'bw'
          ? sampleMappedBinary(px, w, h, map, cand.gridW, cand.gridH)
          : sampleMapped(px, w, h, map, cand.gridW, cand.gridH)
        const readings = equalizeSpatialReadings(rawReadings, cand)
        const cap = capacityBytes(cand)
        const parsed = parseFrameLdpcSoft(softDemodLLR(readings, cand), cap, cand.rate, true)
        if (parsed) {
          locked = cand; lockedZm = null
          rx = new SoftReceiver(cap, cand.rate, cand.enc === 'bw' ? 8 : 24, cand.enc === 'bw')
          reply({ id, result: parsed, found: true, looks: 1, combinedWins: 0, lockedSpec: cand })
          return
        }
        if (cand.enc !== 'bw' && cand.gridW * cand.gridH <= 20000) {
          const zm = buildZoneMap(cand.gridW, cand.gridH, cand.enc)
          if (isMultiZone(zm)) {
            const zcap = capacityBytesZoned(zm)
            const zparsed = parseFrameLdpcSoft(softDemodLLRZoned(readings, zm), zcap, cand.rate, true)
            if (zparsed) {
              locked = cand; lockedZm = zm
              rx = new SoftReceiver(zcap, cand.rate, 24)
              reply({ id, result: zparsed, found: true, looks: 1, combinedWins: 0, lockedSpec: cand })
              return
            }
          }
        }
      } catch { /* OOM — skip */ }
    }
    fCursor = (fCursor + FALLBACK_BUDGET) % CANDIDATES.length
    reply({ id, result: null, found: true, looks: 0, combinedWins: 0 })
  } catch {
    reply({ id, result: null, found: false, looks: 0, combinedWins: 0 })
  }
}

function reply(r: Omit<DecodeReply, 'ms' | 'wasm' | 'spatialSimd' | 'webGpu' | 'gpuSampleMs' | 'dark' | 'quad' | 'tracked' | 'phase' | 'colorConfidence' | 'superLooks' | 'superWins' | 'spatialBlur'>) {
  ;(self as unknown as Worker).postMessage({ ...r, ms: performance.now() - t0, wasm: wasmActive, spatialSimd: spatialSimdActive, webGpu: curWebGpu, gpuSampleMs: curGpuSampleMs, dark: curDark, quad: curQuad, tracked: curTracked, phase: curPhase, colorConfidence: curColorConfidence, superLooks: superRx?.count ?? 0, superWins, spatialBlur: curSpatialBlur })
}

function meanReliability(rel?: Float32Array): number | undefined {
  if (!rel?.length) return undefined
  let sum = 0
  for (let i = 0; i < rel.length; i++) sum += rel[i]
  return sum / rel.length
}

/** Normalise a pixel-space quad to [0,1] of a w×h frame. */
function normQuad(c: Corners, w: number, h: number): NormQuad {
  const n = (p: Pt) => ({ x: p.x / w, y: p.y / h })
  return { tl: n(c.tl), tr: n(c.tr), br: n(c.br), bl: n(c.bl) }
}

export type { DecodeRequest, DecodeReply }
