import { useEffect, useRef, useState, useCallback } from 'react'
import { Tag, Button } from 'antd'
import { CameraOutlined, SwapOutlined, ReloadOutlined, BulbOutlined, AimOutlined } from '@ant-design/icons'
import { type EncodingSpec } from '../services/visualCodec'
import { FRAME_TYPE_DATA, type ParsedFrame, type TransferManifest } from '../services/transferCodec'
import { TIMING_STATE_WORDS } from '../services/timingClaims'
import type { DecodeReply, NormQuad, TrackHint, WebGpuStatus } from '../services/decodeWorker'

interface Props {
    spec?: EncodingSpec   // manual/locked spec; omit when auto === true
    auto?: boolean        // let the worker auto-detect enc/grid/rate
    active: boolean
    manifest?: TransferManifest | null  // pass once decoded so the worker can derive zone map
    // `optical` comes from the same worker reply as `result`.  A compact v6+
    // manifest deliberately omits geometry/rate, so handing the exact spec to
    // the consumer avoids waiting for a separate React detection update.
    onScan: (result: ParsedFrame | null, optical?: EncodingSpec) => void
    onResolution?: (w: number, h: number, fps?: number) => void
    onStats?: (s: { looks: number; combinedWins: number; superLooks: number; superWins: number; ms: number; avgMs: number; maxMs: number; processed: number; wasm: boolean; spatialSimd: boolean; webGpu: boolean; gpuSampleMs: number; webGpuStatus: WebGpuStatus; webGpuReason: string; workerPool: number; turboPairs: number; captureTargetFps: number; timingFps: number; timingSkips: number; laneFrames: [number, number]; proc: number; tracked: number; phase: 'search' | 'bootstrap' | 'payload'; colorConfidence: number; spatialBlur: number; gpuCapture: boolean }) => void
    onDetect?: (spec: EncodingSpec) => void  // fires once auto-detect locks on
    /** Fires when the fixed metadata strip identifies a single or Turbo ×2 layout. */
    onLayoutDetect?: (lanes: 1 | 2) => void
    /** 1 = normal full-frame scan, 2 = two side-by-side Turbo lanes. */
    tileCount?: 1 | 2
    /** Let the sender barcode choose 1/2 lanes; false preserves the user's choice. */
    autoLayout?: boolean
}

type Status = 'starting' | 'permission' | 'scanning' | 'error'

export default function CameraReader({ spec, auto, active, manifest, onScan, onResolution, onStats, onDetect, onLayoutDetect, tileCount = 1, autoLayout = true }: Props) {
    const videoRef = useRef<HTMLVideoElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    // Live tracking overlay: the worker reports the detected matrix corners each
    // frame; we draw bright brackets that hug the tile so the user no longer has
    // to nudge the camera to centre the matrix inside a fixed guide box.
    const overlayRef = useRef<HTMLCanvasElement>(null)
    const quadRef = useRef<{ q: NormQuad; at: number } | null>(null)
    const onScanRef = useRef(onScan)
    onScanRef.current = onScan
    const onResRef = useRef(onResolution)
    onResRef.current = onResolution
    const onStatsRef = useRef(onStats)
    onStatsRef.current = onStats
    const onDetectRef = useRef(onDetect)
    onDetectRef.current = onDetect
    const onLayoutRef = useRef(onLayoutDetect)
    onLayoutRef.current = onLayoutDetect
    // The sender advertises its layout in the fixed barcode. Keep it in a ref so
    // switching from one lane to Turbo ×2 does not tear down the camera/worker pool.
    const layoutRef = useRef<1 | 2>(tileCount)
    layoutRef.current = tileCount
    // Physical layout learned from the sender is distinct from how many lanes
    // the user chose to consume. Forced-single on a Turbo sender should crop L1
    // at full detail, not scan the whole two-tile screen at half cell resolution.
    const sourceLayoutRef = useRef<1 | 2>(tileCount)
    const autoLayoutRef = useRef(autoLayout)
    autoLayoutRef.current = autoLayout
    const manifestRef = useRef(manifest)
    manifestRef.current = manifest
    // Processing resolution (px). Kept modest while SEARCHING (fast, and the barcode
    // strip reads fine at low res), then raised once a spec locks so every cell gets
    // enough pixels to resolve its colour — a big grid downscaled to 900px gives only
    // ~4 px/cell and never decodes. Higher enc + wider grid ⇒ more px/cell needed.
    const procRef = useRef(900)
    const [cameras, setCameras] = useState<{ id: string; label: string }[]>([])
    const [cameraId, setCameraId] = useState<string | null>(null) // null = auto (rear)
    const [status, setStatus] = useState<Status>('starting')
    const [error, setError] = useState<string | null>(null)
    const trackRef = useRef<MediaStreamTrack | null>(null)
    const [retryTick, setRetryTick] = useState(0)    // bump to force a fresh camera acquire
    const [blackFeed, setBlackFeed] = useState(false) // camera is live but the picture is black
    const [torchSupported, setTorchSupported] = useState(false)
    const [torchOn, setTorchOn] = useState(false)

    const cycleCamera = useCallback(() => {
        if (cameras.length < 2) return
        const i = cameras.findIndex(c => c.id === cameraId)
        setCameraId(cameras[(i + 1) % cameras.length].id)
    }, [cameras, cameraId])

    // Flashlight/torch — safe to toggle (unlike focus/exposure LOCKING, which
    // blacked the feed out on some devices, so we never touch those).
    const toggleTorch = useCallback(async () => {
        const track = trackRef.current
        if (!track) return
        const next = !torchOn
        try {
            await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
            setTorchOn(next)
        } catch { /* device refused torch — leave state as is */ }
    }, [torchOn])

    // Nudge a refocus WITHOUT locking: re-assert continuous autofocus. On devices
    // that support it this re-triggers the AF sweep; on others it's a harmless no-op.
    const refocus = useCallback(async () => {
        const track = trackRef.current
        if (!track) return
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }) } catch { /* ignore */ }
    }, [])

    // Keep the receiver's own screen awake while scanning (long transfers otherwise
    // hit the idle lock, which suspends the camera and the decode loop).
    useEffect(() => {
        if (!active) return
        let lock: { release?: () => Promise<void> } | null = null
        const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release?: () => Promise<void> }> } }
        const acquire = () => nav.wakeLock?.request('screen').then(l => { lock = l }).catch(() => {})
        acquire()
        const onVis = () => { if (document.visibilityState === 'visible') acquire() }
        document.addEventListener('visibilitychange', onVis)
        return () => { document.removeEventListener('visibilitychange', onVis); lock?.release?.().catch(() => {}) }
    }, [active])

    // Tracking-bracket draw loop. Runs on its own rAF (independent of the decode
    // workers) so the brackets glide smoothly. It maps the worker's normalised
    // matrix corners onto the displayed video — which is `object-fit: cover`, so
    // the frame is scaled by the LARGER ratio and cropped — and strokes short
    // L-shaped brackets at each corner.
    //
    // Two things keep the brackets STEADY instead of flickering back to the static
    // guide on every dropped frame (the decode workers only report corners on the
    // frames where the matrix is actually located, which is intermittent under
    // motion/blur):
    //   • a long hold (HOLD_MS) keeps the brackets fully lit through short gaps,
    //     fading only over the last FADE_TAIL ms — so a one-frame miss is invisible;
    //   • an exponential-smoothing (EMA) glide of the corners absorbs the small
    //     frame-to-frame jitter between the marker-refined and geometric fits.
    useEffect(() => {
        if (!active) return
        const HOLD_MS = 1400     // keep brackets alive this long after the last sighting
        const FADE_TAIL = 450    // …fading out only across the final stretch
        let raf = 0
        let sm: NormQuad | null = null // EMA-smoothed corners (normalised)
        const lerpN = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
        const draw = () => {
            raf = requestAnimationFrame(draw)
            const cv = overlayRef.current, video = videoRef.current
            if (!cv || !video) return
            const cw = cv.clientWidth, ch = cv.clientHeight
            const vw = video.videoWidth, vh = video.videoHeight
            const dpr = window.devicePixelRatio || 1
            const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr)
            if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph }
            const ctx = cv.getContext('2d')
            if (!ctx) return
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, cw, ch)
            const snap = quadRef.current
            const age = snap ? performance.now() - snap.at : Infinity
            const active2 = !!snap && age < HOLD_MS && cw > 0 && ch > 0 && vw > 0 && vh > 0
            if (!active2 || !snap) { sm = null; return } // lost → next sighting snaps fresh
            // Glide the smoothed corners toward the latest sighting (or snap on first).
            const q = snap.q
            if (!sm) sm = { tl: { ...q.tl }, tr: { ...q.tr }, br: { ...q.br }, bl: { ...q.bl } }
            else {
                // Lower factor ⇒ steadier brackets (more of the per-frame corner
                // jitter is averaged away), at a little tracking lag.
                const e = 0.22
                sm = { tl: lerpN(sm.tl, q.tl, e), tr: lerpN(sm.tr, q.tr, e), br: lerpN(sm.br, q.br, e), bl: lerpN(sm.bl, q.bl, e) }
            }
            // object-fit: cover — scale by the larger ratio, centre, and let the
            // overflow crop. Same mapping the browser uses to paint the <video>.
            const scale = Math.max(cw / vw, ch / vh)
            const dispW = vw * scale, dispH = vh * scale
            const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2
            const toPx = (p: { x: number; y: number }) => ({ x: offX + p.x * dispW, y: offY + p.y * dispH })
            const tl = toPx(sm.tl), tr = toPx(sm.tr), br = toPx(sm.br), bl = toPx(sm.bl)
            // Full opacity through the hold window; only fade across the final tail.
            const alpha = Math.max(0, Math.min(1, (HOLD_MS - age) / FADE_TAIL))
            ctx.lineWidth = 4
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.strokeStyle = `rgba(82,196,26,${alpha})`
            ctx.shadowColor = `rgba(82,196,26,${alpha})`
            ctx.shadowBlur = 8
            // For each corner draw two arms running a fraction of the way along the
            // two edges that meet there — a viewfinder that only lights the corners.
            const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
            const arm = (c: { x: number; y: number }, n1: { x: number; y: number }, n2: { x: number; y: number }) => {
                const f = 0.2
                ctx.beginPath()
                const a1 = lerp(c, n1, f), a2 = lerp(c, n2, f)
                ctx.moveTo(a1.x, a1.y); ctx.lineTo(c.x, c.y); ctx.lineTo(a2.x, a2.y)
                ctx.stroke()
            }
            arm(tl, tr, bl); arm(tr, tl, br); arm(br, tr, bl); arm(bl, tl, br)
            ctx.shadowBlur = 0
        }
        raf = requestAnimationFrame(draw)
        return () => { cancelAnimationFrame(raf); quadRef.current = null }
    }, [active])

    useEffect(() => {
        if (!active) return
        let cancelled = false
        let stream: MediaStream | null = null
        let rafId = 0
        // The decode pipeline (registration + soft demod + LDPC) is pure per-frame
        // work with no cross-frame dependency, so we run a POOL of Web Workers in
        // parallel — one per spare CPU core. Each captured frame goes to an idle
        // worker; on a multi-core phone this multiplies the scan rate by roughly the
        // core count (the single-worker version left every other core idle). Each
        // worker auto-detects independently and converges on the same spec within a
        // few frames, so no cross-worker coordination is needed.
        //
        // Pool size adapts to the DEVICE: more spare cores ⇒ more parallel decodes ⇒
        // proportionally more scan rate (decode is the bottleneck). But each worker
        // also costs memory (its ~940 KB WASM decoder + a proc-sized readback buffer +
        // the LDPC code structures), and over-committing memory is what crashed the
        // tab before — so we also cap by the device's reported RAM. One core is left
        // for the capture/UI thread. Falls back sanely when the hints are missing
        // (Safari has no deviceMemory → treated as mid-range).
        const cores = navigator.hardwareConcurrency || 4
        const ramGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4
        const memCap = ramGb >= 6 ? 8 : ramGb >= 3 ? 5 : 3
        // Camera decode is memory-bandwidth heavy. On mobile, launching five to
        // eight ImageBitmap + LDPC jobs concurrently causes long GC/thermal
        // pauses even though the phone advertises many CPU cores. Three workers
        // keep the receiver responsive while still covering a 6.5-fps sender.
        // High-end receivers can spend a fourth spare core on independent
        // frames.  Huawei-class devices retain the proven three-worker ceiling.
        // Turbo can pipeline two complete L1+L2 pairs. Four workers are modest
        // for the measured 64² Color8 workload (~960px crops) and let the second
        // camera exposure decode while the first pair is still in LDPC. Keep the
        // conservative three-worker ceiling on smaller/low-memory devices.
        // The tuned 64² CPU path no longer creates a WebGPU device/readback in
        // every worker. A genuinely high-end receiver can therefore sustain a
        // third complete Turbo pair for the 12-tick clean-link profile. Keep the
        // proven four-worker ceiling everywhere else; Turbo only uses full pairs.
        const poolCap = ramGb >= 6 && cores >= 8 ? 6 : ramGb >= 4 && cores >= 6 ? 4 : 3
        const POOL = Math.max(1, Math.min(poolCap, memCap, cores - 1))
        const workers: Worker[] = []
        const busy: boolean[] = []
        const sharedTimingTicks = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
            ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * TIMING_STATE_WORDS))
            : null
        sharedTimingTicks?.fill(-1)
        // Turbo lanes are independent optical views. Keep a worker sticky to a
        // lane once it has one, otherwise its SoftReceiver would alternate two
        // unrelated codewords and could never temporal-combine repeated looks.
        const workerLane: number[] = []
        const turboPairs: [number, number][] = []
        let nextTurboPair = 0
        // Once the manifest is known, the sender tells us how frequently the
        // displayed matrix actually changes. A 30-fps camera looking at a 6.5-fps
        // sender otherwise spends most CPU time decoding the same optical frame
        // four or five times. That backlog is what made a transfer look fast at
        // the beginning then slow down later. Keep a little oversampling for
        // display/camera phase jitter, but never enqueue pointless duplicates.
        let nextUsefulCaptureAt = 0
        let reqId = 0
        let processed = 0
        let decodeSamples = 0
        let totalDecodeMs = 0
        let maxDecodeMs = 0
        let trackedFrames = 0
        let decodeEwma = 0
        let slowSamples = 0
        let fastSamples = 0
        let payloadQualitySamples = 0
        let payloadSuccessEwma = 0
        let ultraCleanMode = false
        let ultraCleanSamples = 0
        let ultraWeakSamples = 0
        let gpuCapture = false
        let webGpuEver = false
        let webGpuStatus: WebGpuStatus = 'waiting'
        let webGpuReason = 'waiting for manifest'
        const laneFrames: [number, number] = [0, 0]
        // Worker tracking state is private, so replies can legitimately arrive as
        // payload/bootstrap/payload while the pool warms up. Surface one session-
        // level lock that becomes stable after any worker proves payload tracking.
        let phaseTransferId: number | null = null
        let sessionPayloadLocked = false
        const recentDataSeeds = new Set<number>()
        const recentSeedQueue: number[] = []
        const lastSuccessfulTimingTick: [number | null, number | null] = [null, null]
        const lastObservedTimingTick: [number | null, number | null] = [null, null]
        const laneTrackHints: [TrackHint | null, TrackHint | null] = [null, null]
        const laneTrackHintAt: [number, number] = [0, 0]
        let detectedSenderFps = 0
        let timingSkips = 0
        let duplicatePressure = 0
        let captureTargetFps = 0
        const isAuto = !!auto
        const onWorkerMsg = (wi: number) => (e: MessageEvent<DecodeReply>) => {
            busy[wi] = false
            processed++
            if (!e.data.duplicateFrame) {
                decodeSamples++
                totalDecodeMs += e.data.ms
                if (e.data.ms > maxDecodeMs) maxDecodeMs = e.data.ms
            }
            if (e.data.tracked) trackedFrames++
            if (e.data.webGpu) webGpuEver = true
            const incomingGpuStatus = e.data.webGpuStatus ?? 'waiting'
            const gpuPriority: Record<WebGpuStatus, number> = { waiting: 0, unavailable: 1, rejected: 2, probing: 3, active: 4 }
            if (gpuPriority[incomingGpuStatus] >= gpuPriority[webGpuStatus]) {
                webGpuStatus = incomingGpuStatus
                webGpuReason = e.data.webGpuReason ?? webGpuReason
            }
            if (webGpuEver) webGpuStatus = 'active'
            const repliedLane = workerLane[wi]
            if (repliedLane === 0 || repliedLane === 1) laneFrames[repliedLane]++
            // A barcode-only duplicate reply is intentionally tiny; including it
            // in LDPC capacity estimation would make the scheduler believe the
            // device can decode far more real frames than it actually can.
            if (!e.data.duplicateFrame)
                decodeEwma = decodeEwma === 0 ? e.data.ms : decodeEwma * 0.82 + e.data.ms * 0.18
            const { result, found, lockedSpec } = e.data
            if (!e.data.duplicateFrame && manifestRef.current) {
                const success = result ? 1 : 0
                payloadSuccessEwma = payloadQualitySamples === 0
                    ? success
                    : payloadSuccessEwma * 0.88 + success * 0.12
                payloadQualitySamples++
            }
            const activeTransferId = manifestRef.current?.id ?? null
            if (activeTransferId !== phaseTransferId) {
                phaseTransferId = activeTransferId
                sessionPayloadLocked = false
                recentDataSeeds.clear()
                recentSeedQueue.length = 0
                lastSuccessfulTimingTick[0] = lastSuccessfulTimingTick[1] = null
                lastObservedTimingTick[0] = lastObservedTimingTick[1] = null
                laneTrackHints[0] = laneTrackHints[1] = null
                laneTrackHintAt[0] = laneTrackHintAt[1] = 0
                sharedTimingTicks?.fill(-1)
                duplicatePressure = 0
                ultraCleanMode = false
                ultraCleanSamples = 0
                ultraWeakSamples = 0
            }
            if (e.data.senderFps && e.data.senderFps >= 1 && e.data.senderFps <= 120)
                detectedSenderFps = e.data.senderFps
            const timingLane = e.data.timingLane
            const trackLane = timingLane === 0 || timingLane === 1 ? timingLane : repliedLane
            if ((trackLane === 0 || trackLane === 1) && e.data.trackHint) {
                laneTrackHints[trackLane] = e.data.trackHint
                laneTrackHintAt[trackLane] = performance.now()
            }
            if (timingLane === 0 || timingLane === 1) {
                const repeatedTick = lastObservedTimingTick[timingLane] === e.data.timingTick
                lastObservedTimingTick[timingLane] = e.data.timingTick ?? lastObservedTimingTick[timingLane]
                // The dynamic strip provides a direct duplicate signal even when
                // LDPC was skipped and therefore no fountain seed exists.
                duplicatePressure = duplicatePressure * 0.94 + (e.data.duplicateFrame || repeatedTick ? 0.06 : 0)
                if (e.data.duplicateFrame) {
                    timingSkips++
                    // Shift the next expensive capture away from the stale display
                    // phase. This is a direct clock correction, while the slower
                    // duplicate-pressure loop remains the long-term rate control.
                    if (detectedSenderFps > 0) {
                        const phaseDelay = 1000 / detectedSenderFps * 0.45
                        nextUsefulCaptureAt = Math.max(nextUsefulCaptureAt, performance.now() + phaseDelay)
                    }
                }
                if (result && e.data.timingTick != null)
                    lastSuccessfulTimingTick[timingLane] = e.data.timingTick
                if (result && e.data.timingTick != null && sharedTimingTicks)
                    Atomics.store(sharedTimingTicks, timingLane, e.data.timingTick)
            }
            if (activeTransferId != null && e.data.phase === 'payload') sessionPayloadLocked = true
            const stablePhase = sessionPayloadLocked ? 'payload' : (e.data.phase ?? 'search')
            if (result?.type === FRAME_TYPE_DATA) {
                const duplicate = recentDataSeeds.has(result.seed)
                duplicatePressure = duplicatePressure * 0.92 + (duplicate ? 0.08 : 0)
                if (!duplicate) {
                    recentDataSeeds.add(result.seed)
                    recentSeedQueue.push(result.seed)
                    if (recentSeedQueue.length > 256) recentDataSeeds.delete(recentSeedQueue.shift()!)
                }
            }
            if (e.data.lanes) {
                sourceLayoutRef.current = e.data.lanes
                if (autoLayoutRef.current) {
                    const changed = layoutRef.current !== e.data.lanes
                    layoutRef.current = e.data.lanes
                    if (changed) {
                        workerLane.fill(-1)
                        turboPairs.length = 0
                        nextTurboPair = 0
                    }
                    onLayoutRef.current?.(e.data.lanes)
                }
            }
            if (lockedSpec) {
                onDetectRef.current?.(lockedSpec)
                // Raise processing resolution to give this grid enough px/cell.
                // The matrix only fills PART of the camera frame, so the multiplier
                // targets the needed px/cell AFTER that fill loss (≈0.6–0.7) — e.g.
                // color16 wants ~7 px/cell on the cell, so ~12×gridW on the frame.
                const dense = Math.max(lockedSpec.gridW, lockedSpec.gridH) >= 96
                const pxPer = lockedSpec.enc === 'color64' ? 18 : lockedSpec.enc === 'color32' ? 16
                    : lockedSpec.enc === 'color16' ? 15 : lockedSpec.enc === 'color8' ? 14
                    : dense ? 15 : 10
                const need = Math.max(lockedSpec.gridW, lockedSpec.gridH) * pxPer
                // Resolution drives DECODE SUCCESS (px/cell). The per-frame cost is
                // dominated by fixed JS work (locate/sample), not the readback, so a
                // low proc barely helped the scan rate while starving cells of pixels
                // and cratering success — net throughput fell. The parallel worker
                // pool supplies the scan rate; here we spend pixels on success. Floor
                // 960 keeps ~9 px/cell even on a 64² grid that fills part of the frame.
                // Dense symbols need the camera's full 1080p vertical detail.  Keep
                // the *same full-frame coordinate system* and raise only the decode
                // resolution; changing to a centre crop after the manifest arrives
                // invalidates finder scale/geometry exactly at payload start.
                const procCap = dense ? 1920 : 1600
                if (isAuto) procRef.current = Math.min(procCap, Math.max(960, Math.round(need)))
            }
            // On the proven Color8 64×64 link, 900px still leaves a safe cell
            // footprint. If decoding stays slow for several frames, lower the
            // processing edge by a tiny step instead of letting camera work build
            // heat/latency for the rest of a long transfer. A clean link restores
            // the normal 960px detail after a sustained recovery.
            const activeManifest = manifestRef.current
            // Once the dense-BW manifest closes, raise detail for the real native
            // 128² payload. This transition changes resolution only, never crop.
            if (isAuto && activeManifest?.enc === 'bw'
                && Math.max(activeManifest.gridW, activeManifest.gridH) >= 96) {
                procRef.current = Math.min(1920, Math.max(1280,
                    Math.round(Math.max(activeManifest.gridW, activeManifest.gridH) * 15)))
            }
            const isTunedColor8 = isAuto && activeManifest?.enc === 'color8'
                && activeManifest.gridW <= 72 && activeManifest.gridH <= 72
            if (isTunedColor8 && processed >= 10) {
                const fast72 = activeManifest!.gridW > 64 || activeManifest!.gridH > 64
                const normalProc = fast72 ? 1008 : 960
                if (fast72) {
                    // Density is useful only while the optical margin remains clean.
                    // Walk down to 900px after several strong payload decodes. On an
                    // exceptionally clean, almost-fully-tracked link, continue to a
                    // guarded 810px floor; hysteresis restores 900–1008px before a
                    // short optical wobble can become sticky.
                    const qualityGood = (e.data.colorConfidence ?? 0) >= 0.80
                        && (e.data.spatialBlur ?? 1) <= 0.06
                        && payloadQualitySamples >= 8 && payloadSuccessEwma >= 0.78
                    const standardWeak = payloadQualitySamples >= 4
                        && ((e.data.colorConfidence ?? 0) < 0.76
                            || (e.data.spatialBlur ?? 0) > 0.085
                            || payloadSuccessEwma < 0.68)
                    const trackRatio = processed > 0 ? trackedFrames / processed : 0
                    const ultraCandidate = payloadQualitySamples >= 12
                        && trackRatio >= 0.85
                        && (e.data.colorConfidence ?? 0) >= 0.93
                        && (e.data.spatialBlur ?? 1) <= 0.03
                        && payloadSuccessEwma >= 0.82
                    const ultraHealthy = trackRatio >= 0.72
                        && (e.data.colorConfidence ?? 0) >= 0.86
                        && (e.data.spatialBlur ?? 1) <= 0.06
                        && payloadSuccessEwma >= 0.74
                    if (ultraCandidate) {
                        ultraCleanSamples = Math.min(16, ultraCleanSamples + 1)
                        ultraWeakSamples = 0
                    } else if (!ultraHealthy) {
                        ultraWeakSamples++
                        ultraCleanSamples = Math.max(0, ultraCleanSamples - 3)
                    } else {
                        // A merely good exposure is not evidence against the clean
                        // link; decay one point instead of erasing the whole history.
                        ultraCleanSamples = Math.max(0, ultraCleanSamples - 1)
                        ultraWeakSamples = 0
                    }
                    if (!ultraCleanMode && ultraCleanSamples >= 8) {
                        ultraCleanMode = true; ultraCleanSamples = 0
                    } else if (ultraCleanMode && ultraWeakSamples >= 4) {
                        ultraCleanMode = false; ultraWeakSamples = 0
                    }
                    const minProc = ultraCleanMode ? 810 : 900
                    const needsDetail = standardWeak || (!ultraCleanMode && procRef.current < 900)
                    if (needsDetail) { fastSamples++; slowSamples = 0 }
                    else if (decodeEwma > 175 && qualityGood) { slowSamples++; fastSamples = 0 }
                    else { slowSamples = 0; fastSamples = 0 }
                    if (slowSamples >= 5 && procRef.current > minProc) {
                        procRef.current = Math.max(minProc, procRef.current - 36)
                        slowSamples = 0
                    } else if (fastSamples >= 3 && procRef.current < normalProc) {
                        procRef.current = Math.min(normalProc, procRef.current + 54)
                        fastSamples = 0
                    }
                } else {
                    const minProc = 900
                    if (decodeEwma > 235) { slowSamples++; fastSamples = 0 }
                    else if (decodeEwma < 180) { fastSamples++; slowSamples = 0 }
                    else { slowSamples = 0; fastSamples = 0 }
                    if (slowSamples >= 8 && procRef.current > minProc) {
                        procRef.current = Math.max(minProc, procRef.current - 30)
                        slowSamples = 0
                    } else if (fastSamples >= 14 && procRef.current < normalProc) {
                        procRef.current = Math.min(normalProc, procRef.current + 30)
                        fastSamples = 0
                    }
                }
            }
            onStatsRef.current?.({
                looks: e.data.looks, combinedWins: e.data.combinedWins, superLooks: e.data.superLooks ?? 0, superWins: e.data.superWins ?? 0, ms: e.data.ms,
                avgMs: decodeSamples ? totalDecodeMs / decodeSamples : 0, maxMs: maxDecodeMs, processed,
                wasm: e.data.wasm, spatialSimd: e.data.spatialSimd ?? false, webGpu: webGpuEver, gpuSampleMs: e.data.gpuSampleMs ?? 0, webGpuStatus, webGpuReason, workerPool: workers.length, turboPairs: turboPairs.length, captureTargetFps, timingFps: detectedSenderFps, timingSkips, laneFrames: [...laneFrames], proc: procRef.current, tracked: trackedFrames,
                phase: stablePhase, colorConfidence: e.data.colorConfidence ?? 0, spatialBlur: e.data.spatialBlur ?? 0, gpuCapture,
            })
            setBlackFeed(e.data.dark)
            // Stash the latest detected quad for the tracking-bracket draw loop.
                // A lane-local quad cannot be placed correctly over the full video
                // without the crop transform, so retain the visual guide only for
                // the normal single-matrix scanner.
                if (layoutRef.current === 1 && e.data.quad) quadRef.current = { q: e.data.quad, at: performance.now() }
            // A barcode-confirmed duplicate never entered LDPC, so it is neither
            // a valid nor a failed optical decode attempt. Keep benchmark rates
            // honest and expose it separately through timingSkips.
            if (!e.data.duplicateFrame)
                onScanRef.current(found ? result : null, e.data.lockedSpec)
        }
        for (let i = 0; i < POOL; i++) {
            const wk = new Worker(new URL('../services/decodeWorker.ts', import.meta.url), { type: 'module' })
            wk.onmessage = onWorkerMsg(i)
            wk.onerror = () => { busy[i] = false } // a crash must not wedge the pool
            workers.push(wk); busy.push(false); workerLane.push(-1)
        }

        // 1080p @ 30 — a 4K frame is far more expensive to draw+read back every tick
        // than it's worth on a phone (the readback, not the sensor, is the bottleneck),
        // and 1080p already feeds ~13 px/cell at grid 64. IDEAL hints; device falls back.
        // Do not cap the camera below its native cadence. On the Huawei link a
        // forced 15fps mode made autofocus/exposure cadence worse and dropped
        // valid frames sharply, even though the sender itself is only 6.5fps.
        // The dispatch gate below still limits expensive decoding to useful frames.
        const hi = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        const attempts: MediaStreamConstraints[] = cameraId
            ? [{ video: { deviceId: { exact: cameraId }, ...hi } },
            { video: { deviceId: { exact: cameraId } } },
            { video: { facingMode: { ideal: 'environment' } } },
            { video: true }]
            : [{ video: { facingMode: { ideal: 'environment' }, ...hi } },
            { video: { facingMode: { ideal: 'environment' } } },
            { video: true }]

        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

        async function acquire(): Promise<MediaStream> {
            let last: unknown = null
            for (const c of attempts) {
                for (let attempt = 0; attempt < 4; attempt++) {
                    if (cancelled) throw new Error('cancelled')
                    try {
                        // مؤقت زمني لكسر التعليق الصامت بعد 6 ثوانٍ
                        return await Promise.race([
                            navigator.mediaDevices.getUserMedia(c),
                            new Promise<MediaStream>((_, reject) =>
                                setTimeout(() => reject(new Error('TimeoutError: الكاميرا لا تستجيب، يبدو أن البيئة معلقة')), 6000)
                            )
                        ])
                    } catch (e) {
                        last = e
                        const name = (e as { name?: string })?.name
                        const msg = (e as { message?: string })?.message
                        if (name === 'NotAllowedError' || name === 'SecurityError') throw e
                        if (msg && msg.includes('TimeoutError')) throw e
                        if ((name === 'AbortError' || name === 'NotReadableError') && attempt < 3) {
                            await sleep(350 + attempt * 400); continue
                        }
                        break
                    }
                }
            }
            throw last
        }

        ; (async () => {
            try {
                setStatus('permission')
                stream = await acquire()
                if (cancelled) {
                    stream.getTracks().forEach(t => t.stop());
                    return
                }

                const video = videoRef.current!
                video.srcObject = stream

                // التقاط أخطاء التشغيل التلقائي لمنع توقف التنفيذ
                await video.play().catch(e => { throw new Error('فشل تشغيل الفيديو: ' + e.message) })

                setStatus('scanning')
                const track0 = stream.getVideoTracks()[0]
                trackRef.current = track0
                const st = track0?.getSettings?.()
                const rw = st?.width ?? video.videoWidth, rh = st?.height ?? video.videoHeight
                onResRef.current?.(rw, rh, st?.frameRate)
                // Torch capability (Android Chrome mostly) → show the flashlight button.
                try {
                    const caps = (track0?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean }
                    setTorchSupported(!!caps.torch)
                } catch { setTorchSupported(false) }
                setTorchOn(false)

                // NOTE: no applyConstraints focus/exposure manipulation — it
                // repeatedly turned the live feed BLACK across devices (Android
                // exposure lock, and laptop/webcam focus). We rely on the camera's
                // native continuous autofocus, and only WARN if the feed is black.

                try {
                    const devs = (await navigator.mediaDevices.enumerateDevices())
                        .filter(d => d.kind === 'videoinput')
                        .map(d => ({ id: d.deviceId, label: d.label || 'كاميرا' }))
                    if (!cancelled && devs.length) setCameras(devs)
                } catch { /* ignore */ }

                const canvas = canvasRef.current!
                const ctx = canvas.getContext('2d', { willReadFrequently: true })!

                // Processing-canvas size. The main-thread cost is getImageData + drawImage
                // on this canvas EVERY frame — the real throughput bottleneck on phones
                // (a 1500² readback was ~400 ms/frame → only 1-2 scans/s). 1050 keeps
                // ~13 px/cell at grid 64 (plenty for reliable colour reads) while cutting
                // that readback ~2× → roughly doubles the scan rate.
                const maxGrid = isAuto ? 64 : Math.max(spec?.gridW ?? 64, spec?.gridH ?? 64)
                const fixedProc = isAuto ? 0 : Math.min(1200, Math.max(360, Math.round(maxGrid * 13)))
                // Prefer createImageBitmap: it crops+resizes on the GPU and lets the
                // worker do the pixel readback, keeping the UI thread light (the old
                // per-frame getImageData allocated ~3 MB on the main thread → GC stalls
                // → the 0-scan hiccups). Fall back to canvas getImageData if unsupported.
                const useBitmap = typeof createImageBitmap === 'function'
                gpuCapture = useBitmap
                const dispatch = (wi: number, lane: number, vw: number, vh: number) => {
                    // Turbo uses square, slightly-overlapping windows at the two
                    // horizontal screen lanes. A landscape monitor inside a
                    // portrait phone video otherwise wastes most decoder pixels on
                    // the black area above/below the screen. Each worker still sees
                    // a perfectly ordinary GridData tile and uses its own barcode.
                    const laneCount = layoutRef.current
                    const sourceLaneCount = sourceLayoutRef.current
                    const activeManifest = manifestRef.current
                    const knownEnc = activeManifest?.enc
                    // Single-lane capture must NEVER change its crop when metadata
                    // arrives.  That transition was the root cause of the working
                    // bootstrap / dead payload failure, and restricting it to >=96
                    // merely moved the same bug to every dense profile.  Dense modes
                    // now obtain their pixels by increasing `proc`, above, while the
                    // optical coordinate system remains identical for the whole run.
                    const cropTurboTile = laneCount === 2 || sourceLaneCount === 2
                    const cropW = cropTurboTile ? Math.max(1, Math.round(vw * 0.56)) : vw
                    const cropH = cropTurboTile ? Math.min(vh, cropW) : vh
                    const sx = cropTurboTile ? (lane === 0 ? 0 : vw - cropW) : 0
                    const sy = cropTurboTile ? Math.max(0, Math.round((vh - cropH) / 2)) : 0
                    const ar = cropW / cropH
                    const proc = isAuto ? procRef.current : fixedProc
                    const procW = ar >= 1 ? proc : Math.round(proc * ar)
                    const procH = ar >= 1 ? Math.round(proc / ar) : proc
                    // Low-quality resize is quick for binary/color8 cells, but it
                    // blends the intermediate levels used by color16+ before the
                    // decoder can calibrate them. Preserve those levels once the
                    // manifest has identified the encoding.
                    const resizeQuality = knownEnc === 'color16' || knownEnc === 'color32' || knownEnc === 'color64'
                        ? 'medium' as const : 'low' as const
                    busy[wi] = true
                    if (laneCount === 2) workerLane[wi] = lane
                    const rid = reqId++
                    const trackHint = performance.now() - laneTrackHintAt[lane] <= 750
                        ? laneTrackHints[lane] ?? undefined
                        : undefined
                    if (useBitmap) {
                        createImageBitmap(video, sx, sy, cropW, cropH, { resizeWidth: procW, resizeHeight: procH, resizeQuality })
                            .then(bmp => { if (cancelled) { bmp.close(); return } workers[wi].postMessage({ bitmap: bmp, w: procW, h: procH, auto: isAuto, spec, manifest: manifestRef.current ?? undefined, lastTimingTick: lastSuccessfulTimingTick[lane] ?? undefined, expectedLane: lane, timingState: sharedTimingTicks?.buffer as SharedArrayBuffer | undefined, trackHint, id: rid }, [bmp]) })
                            .catch(() => { busy[wi] = false })
                    } else {
                        canvas.width = procW; canvas.height = procH
                        ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, procW, procH)
                        const img = ctx.getImageData(0, 0, procW, procH)
                        workers[wi].postMessage({ pixels: img.data.buffer, w: procW, h: procH, auto: isAuto, spec, manifest: manifestRef.current ?? undefined, lastTimingTick: lastSuccessfulTimingTick[lane] ?? undefined, expectedLane: lane, timingState: sharedTimingTicks?.buffer as SharedArrayBuffer | undefined, trackHint, id: rid }, [img.data.buffer])
                    }
                }
                type VideoFrameCapable = HTMLVideoElement & {
                    requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number
                }
                const frameVideo = video as VideoFrameCapable
                const schedule = (loop: () => void) => {
                    if (frameVideo.requestVideoFrameCallback) frameVideo.requestVideoFrameCallback(() => loop())
                    else rafId = requestAnimationFrame(loop)
                }
                const loop = () => {
                    if (cancelled) return
                    try {
                        if (video.readyState >= video.HAVE_ENOUGH_DATA) {
                            const vw = video.videoWidth, vh = video.videoHeight
                            if (vw > 0 && vh > 0) {
                                const now = performance.now()
                                // Feed EVERY idle worker this tick → all cores stay busy.
                                // Once the manifest is known, do not spend several
                                // workers decoding identical camera exposures of one
                                // displayed frame. The sender advertises its FPS, so
                                // this keeps one useful decode opportunity per frame.
                                const laneCount = layoutRef.current
                                const hasManifest = !!manifestRef.current
                                const binaryMode = manifestRef.current?.enc === 'bw'
                                const dispatches: { worker: number; lane: number }[] = []
                                // A Turbo exposure is one atomic pair. Wait until
                                // both lane-owned workers are idle, then crop L1 and
                                // L2 from the exact same camera frame. Letting the
                                // faster lane run alone made its counter race ahead
                                // and reassigned workers across unrelated SoftReceiver
                                // histories. Once assigned, ownership never crosses.
                                if (laneCount === 2 && workers.length >= 2) {
                                    // Bootstrap keeps a single stateful pair so its
                                    // SoftReceivers can combine repeated manifest
                                    // looks. Payload may use every complete pair:
                                    // on a four-worker device pair B overlaps pair A
                                    // without ever decoding the same camera exposure.
                                    const desiredPairs = hasManifest ? Math.floor(workers.length / 2) : 1
                                    while (turboPairs.length < desiredPairs) {
                                        const free = workerLane
                                            .map((lane, wi) => ({ lane, wi }))
                                            .filter(item => item.lane < 0 && !busy[item.wi])
                                            .map(item => item.wi)
                                        if (free.length < 2) break
                                        const pair: [number, number] = [free[0], free[1]]
                                        workerLane[pair[0]] = 0
                                        workerLane[pair[1]] = 1
                                        turboPairs.push(pair)
                                    }
                                    for (let offset = 0; offset < turboPairs.length; offset++) {
                                        const pairIndex = (nextTurboPair + offset) % turboPairs.length
                                        const pair = turboPairs[pairIndex]
                                        if (!busy[pair[0]] && !busy[pair[1]]) {
                                            dispatches.push({ worker: pair[0], lane: 0 }, { worker: pair[1], lane: 1 })
                                            nextTurboPair = (pairIndex + 1) % turboPairs.length
                                            break
                                        }
                                    }
                                }
                                // Bootstrap frames are deliberately repeated so one
                                // SoftReceiver can combine several camera looks and
                                // close the manifest. Distributing those identical
                                // looks over the pool left every worker below its BP
                                // threshold (especially BW 128), so the UI remained in
                                // "initial tracking" and never learned K. Keep worker
                                // 0 sticky only until the authoritative manifest is
                                // decoded; payload immediately fans back out below.
                                if (!hasManifest) {
                                    if (laneCount === 1) {
                                        if (!busy[0]) dispatches.push({ worker: 0, lane: 0 })
                                    }
                                }
                                // A Turbo camera exposure contains BOTH optical tiles.
                                // Dispatch the two crops from this same exposure whenever
                                // two workers are free; the old scheduler alternated lanes
                                // and discarded half of every captured screen image.
                                // A dense BW decode commonly takes >100 ms. Restricting
                                // it to worker 0 capped the entire 10-fps profile at
                                // 3-5 scans/s and discarded most displayed symbols.
                                // Independent LDPC frames are safe to distribute; each
                                // worker retains its own bounded soft/SR fallback.
                                // Payload frames now advance every sender tick. They
                                // are independent fountain equations, so distribute
                                // BW as well as colour across the pool; keeping BW on
                                // worker 0 after temporal holds were removed imposed a
                                // needless ~one-decode-time throughput ceiling.
                                if (hasManifest && laneCount === 1) for (let wi = 0; wi < workers.length; wi++) {
                                    if (!busy[wi]) { dispatches.push({ worker: wi, lane: 0 }); break }
                                }
                                // Timing barcode is available before the manifest,
                                // so acquisition and payload share the sender's real
                                // clock instead of beginning from a guessed cadence.
                                const advertisedFps = manifestRef.current?.fps ?? (detectedSenderFps || undefined)
                                // When the worker is comfortably below the camera/display
                                // budget, sample about 1.5 exposures per displayed frame.
                                // That gives SoftReceiver two geometrically registered looks
                                // to combine before LDPC. Slow devices fall back to the old
                                // low-overhead cadence instead of building a queue.
                                // Oversample only enough to tolerate camera/display
                                // phase jitter. The former 1.55x/2.4x policy decoded
                                // many duplicate screen frames, spending CPU without
                                // adding fountain symbols and lowering goodput.
                                // A Turbo screen changes each *lane* exactly once per
                                // sender tick.  The old 1.20× oversampling therefore
                                // revisited a lane every ~92 ms at 9 fps while its
                                // picture remained on screen for ~111 ms.  Those jobs
                                // were guaranteed duplicate fountain seeds (and showed
                                // up as dataDuplicate in the field report).  Pace a
                                // two-lane payload close to its advertised symbol
                                // clock.  A strict 1:1 cadence aliases badly with this
                                // device's 30fps camera versus a 9fps screen ticker:
                                // field testing increased both duplicates and transfer
                                // time.  A 4% phase margin is the measured optimum;
                                // preserve the richer temporal policy for one matrix.
                                // Two pipelined pairs can outrun the sender's real
                                // browser paint cadence even when it advertises 9fps.
                                // Repeated fountain seeds are an exact phase-error
                                // signal. Back off smoothly (down to 78%) until new
                                // seeds dominate again, reducing LDPC/thermal load
                                // without guessing the sender display's true rate.
                                const temporalFactor = laneCount === 2
                                    ? Math.max(0.78, 1.02 - duplicatePressure * 0.90)
                                    : decodeEwma > 0 && decodeEwma < 165 ? 1.20
                                        : decodeEwma > 0 && decodeEwma < 240 ? 1.12 : 1.05
                                // Turbo is always dispatched as two simultaneous jobs,
                                // so its callback clock follows the sender tick directly.
                                // One Turbo exposure always represents two jobs,
                                // including the callback ticks where both pairs are
                                // busy. Using dispatches.length here made the idle
                                // diagnostic briefly divide by one and report an
                                // impossible captureTargetFps above senderFps.
                                const jobs = laneCount === 2 ? 2 : 1
                                const opticalTargetFps = advertisedFps
                                    ? Math.min(binaryMode ? 26 : laneCount === 2 ? 22 : 14, Math.max(3, advertisedFps * laneCount / jobs * temporalFactor))
                                    : (laneCount === 2 ? (jobs >= 2 ? 9 : 18) : 24)
                                // Fast advertises a 12-tick ceiling, but the receiver
                                // chooses how much of it to consume. Derive a safe
                                // exposure rate from the measured decode EWMA and the
                                // workers that form complete Turbo pairs. Four-worker
                                // devices settle near 9fps; six-worker devices can
                                // rise to the full 12fps without a feedback channel.
                                const activeDecodeWorkers = laneCount === 2
                                    ? Math.max(2, turboPairs.length * 2)
                                    : workers.length
                                const processingCapacityFps = hasManifest && decodeEwma > 0
                                    ? activeDecodeWorkers * 1000 / decodeEwma / jobs * 0.90
                                    : opticalTargetFps
                                const targetFps = Math.max(3, Math.min(opticalTargetFps, processingCapacityFps))
                                captureTargetFps = targetFps
                                if (dispatches.length > 0 && now >= nextUsefulCaptureAt) {
                                    for (const job of dispatches) dispatch(job.worker, job.lane, vw, vh)
                                    // Keep the capture clock phase-locked instead of
                                    // scheduling the next deadline from *this* camera
                                    // callback. At 30fps a 12.6fps target otherwise
                                    // rounds 79ms up to the next 33ms video tick on
                                    // every iteration (about 10fps in practice).
                                    // Carrying the ideal deadline forward produces the
                                    // intended 12–13 useful opportunities/sec and is
                                    // especially important for Turbo's two lanes.
                                    const interval = 1000 / targetFps
                                    nextUsefulCaptureAt = nextUsefulCaptureAt > 0
                                        ? nextUsefulCaptureAt + interval
                                        : now + interval
                                    // If a long camera/GC pause put us more than one
                                    // interval behind, do not burst stale captures.
                                    if (nextUsefulCaptureAt < now - interval) nextUsefulCaptureAt = now + interval
                                }
                            }
                        }
                    } catch { /* never let a frame error kill the capture loop */ }
                    schedule(loop)
                }
                schedule(loop)
            } catch (e) {
                if (!cancelled) { setStatus('error'); setError(errText(e)) }
            }
        })()

        // التنظيف العميق لمنع بقاء المستشعر قيد التشغيل في الخلفية على أجهزة الموبايل
        return () => {
            cancelled = true
            cancelAnimationFrame(rafId)
            workers.forEach(wk => wk.terminate())
            trackRef.current = null
            if (stream) {
                stream.getTracks().forEach(t => {
                    t.stop()
                    t.enabled = false
                })
            }
            if (videoRef.current) {
                videoRef.current.srcObject = null
            }
        }
    }, [active, cameraId, auto, spec?.enc, spec?.gridW, spec?.gridH, retryTick])

    const statusColor: Record<Status, string> = {
        starting: 'default', permission: 'warning', scanning: 'success', error: 'error',
    }
    const statusLabel: Record<Status, string> = {
        starting: 'جاري البدء', permission: 'بانتظار إذن الكاميرا', scanning: 'يفحص', error: 'خطأ',
    }

    return (
        <div>
            <div
                style={{ position: 'relative', width: '100%', height: '100%', margin: '0 auto', overflow: 'hidden', background: '#000' }}
            >
                <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
                {/* Live tracking brackets that hug the detected matrix (auto-align). */}
                <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }} />
                {blackFeed && status === 'scanning' && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: 16, textAlign: 'center', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 13,
                    }}>
                        الكاميرا شغّالة لكن الصورة سوداء — تأكّد من عدم وجود غطاء خصوصية، وأن لا تطبيق/تبويب آخر يستخدم الكاميرا، ثم أعد المحاولة أو بدّل الكاميرا.
                    </div>
                )}
                {/* Camera controls overlay */}
                {status === 'scanning' && (
                    <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 15, display: 'flex', gap: 6 }}>
                        <Button size="small" icon={<AimOutlined />} onClick={refocus}
                            style={{ background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff' }} />
                        {torchSupported && (
                            <Button size="small" icon={<BulbOutlined />} onClick={toggleTorch}
                                style={{ background: torchOn ? 'rgba(250,173,20,0.8)' : 'rgba(0,0,0,0.5)', border: 'none', color: '#fff' }} />
                        )}
                        {cameras.length > 1 && (
                            <Button size="small" icon={<SwapOutlined />} onClick={cycleCamera}
                                style={{ background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff' }} />
                        )}
                    </div>
                )}
                {/* Status badge */}
                {status !== 'scanning' && (
                    <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 5 }}>
                        <Tag color={statusColor[status]} icon={<CameraOutlined />}>{statusLabel[status]}</Tag>
                    </div>
                )}
            </div>

            {(error || status === 'error') && (
                <div style={{ marginTop: 8 }}>
                    {error && <div style={{ color: '#ff4d4f', marginBottom: 8 }}>خطأ: {error}</div>}
                    <Button
                        icon={<ReloadOutlined />}
                        onClick={() => { setError(null); setStatus('starting'); setRetryTick(t => t + 1) }}
                    >
                        إعادة محاولة فتح الكاميرا
                    </Button>
                </div>
            )}
        </div>
    )
}

function errText(e: unknown): string {
    const s = String(e)
    if (/NotAllowedError|Permission|SecurityError/i.test(s)) return 'رُفض إذن الكاميرا. اسمح بالوصول للكاميرا من إعدادات المتصفح ثم أعد المحاولة.'
    if (/NotFoundError|OverconstrainedError/i.test(s)) return 'لا توجد كاميرا متاحة مطابقة.'
    if (/AbortError|NotReadableError/i.test(s))
        return 'تعذّر تشغيل الكاميرا — غالباً لأنها مستخدمة من تطبيق آخر. أغلق التطبيقات الأخرى ثم أعد المحاولة.'
    return s
}
