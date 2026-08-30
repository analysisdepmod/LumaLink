import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Card, Button, Progress, Typography, Space,
  Alert, Result, Input, Tag, message, Segmented, Switch,
} from 'antd'
import {
  CameraOutlined, CheckCircleOutlined, DownloadOutlined, CopyOutlined, ReloadOutlined,
} from '@ant-design/icons'
import CameraReader from '../components/CameraReader'
import { type Encoding, type EncodingSpec } from '../services/visualCodec'
import {
  FRAME_TYPE_MANIFEST, FRAME_TYPE_SOLO, ManifestAssembler, finishTransfer, parseSolo,
  isValidManifest, type TransferManifest, type ParsedFrame,
} from '../services/transferCodec'
import { FountainDecoder } from '../services/fountainDecoder'
import { saveDiagnosticReport } from '../services/diagnosticLog'
import { assessOpticalLink, type OpticalCalibration } from '../services/opticalCalibration'
import { playChannelTone } from '../services/channelTone'

const { Title, Paragraph, Text } = Typography

interface Snapshot {
  k: number
  unique: number
  quality: number      // 0..1 rolling valid-scan rate
  speed: number        // KB/s instantaneous recovered-data rate
  averageSpeed: number // KB/s since first data frame
  eta: number          // seconds remaining (-1 = unknown)
  manifestSeen: boolean
  attempts: number
  scanRate: number     // camera scans processed per second
  combinedWins: number // frames recovered thanks to soft-combining ≥2 looks
}

interface Result_ {
  name: string
  mime: string
  kind: 'file' | 'text'
  bytes: Uint8Array
  url?: string
  text?: string
  benchmark?: { seconds: number; goodputKBs: number; applicationGoodputKBs: number; validFrames: number; attempts: number; verified: boolean; report: string; calibration: OpticalCalibration | null }
}

const EMPTY: Snapshot = { k: 0, unique: 0, quality: 0, speed: 0, averageSpeed: 0, eta: -1, manifestSeen: false, attempts: 0, scanRate: 0, combinedWins: 0 }

const ENC_LABEL: Record<Encoding, string> = {
  bw: 'أبيض وأسود', color8: '8 ألوان', color16: '16 لون', color32: '32 لون', color64: '64 لون',
}

export default function ReceivePage() {
  const [active, setActive] = useState(false)
  const [tileCount, setTileCount] = useState<1 | 2>(1)
  const [layoutAuto, setLayoutAuto] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(false)
  const tileCountRef = useRef<1 | 2>(1)
  tileCountRef.current = tileCount
  // Force one render when the optical manifest arrives so CameraReader receives
  // it as a prop and forwards the authoritative spec to every decode worker.
  // Without this, only the worker that happened to see the manifest could lock.
  const [, setManifestEpoch] = useState(0)
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const [result, setResult] = useState<Result_ | null>(null)
  const [camRes, setCamRes] = useState<{ w: number; h: number; fps?: number } | null>(null)
  // The worker auto-detects the sender's encoding/grid/rate — no manual matching.
  const [detected, setDetected] = useState<EncodingSpec | null>(null)
  const cameraRef = useRef<{ w: number; h: number; fps?: number } | null>(null)
  const detectedRef = useRef<EncodingSpec | null>(null)
  const soundEnabledRef = useRef(false)
  const lockTonePlayedRef = useRef(false)
  soundEnabledRef.current = soundEnabled

  // Mutable decode state (updated per scan, published to React on an interval).
  const decoderRef = useRef<FountainDecoder | null>(null)
  const manifestRef = useRef<TransferManifest | null>(null)
  const assemblerRef = useRef(new ManifestAssembler())
  const attemptsRef = useRef(0)
  const qualityRef = useRef(0)
  const startRef = useRef(0)
  // Advances whenever buffered pre-manifest frames are released. The live-speed
  // display resets its sampling window at that boundary, so a buffer flush is not
  // mistaken for an impossibly fast optical link.
  const speedEpochRef = useRef(0)
  const doneRef = useRef(false)
  const statsRef = useRef({ looks: 0, combinedWins: 0, superLooks: 0, superWins: 0, ms: 0, avgMs: 0, maxMs: 0, processed: 0, wasm: false, spatialSimd: false, webGpu: false, gpuSampleMs: 0, webGpuStatus: 'waiting' as 'waiting' | 'probing' | 'active' | 'unavailable' | 'rejected', webGpuReason: 'waiting for manifest', workerPool: 0, turboPairs: 0, captureTargetFps: 0, timingFps: 0, timingSkips: 0, laneFrames: [0, 0] as [number, number], proc: 0, tracked: 0, phase: 'search' as 'search' | 'bootstrap' | 'payload', colorConfidence: 0, spatialBlur: 0, gpuCapture: false })
  const runRef = useRef({ firstValidAt: 0, firstDataAt: 0, validFrames: 0 })
  const pendingDataRef = useRef<ParsedFrame[]>([])
  const diagRef = useRef({ manifest: 0, data: 0, dataUnique: 0, dataDuplicate: 0, dataRedundant: 0, solo: 0, soloFail: 0, manifestNull: 0, dataDropped: 0, dataBuffered: 0, manifestInvalid: 0, parts: '-' })
  const [diag, setDiag] = useState({ manifest: 0, data: 0, dataUnique: 0, dataDuplicate: 0, dataRedundant: 0, solo: 0, soloFail: 0, manifestNull: 0, dataDropped: 0, dataBuffered: 0, manifestInvalid: 0, parts: '-', ms: 0, wasm: false, webGpu: false, webGpuStatus: 'waiting' as 'waiting' | 'probing' | 'active' | 'unavailable' | 'rejected', webGpuReason: 'waiting for manifest', laneFrames: [0, 0] as [number, number], phase: 'search' as 'search' | 'bootstrap' | 'payload', colorConfidence: 0 })

  const reset = useCallback(() => {
    decoderRef.current?.dispose()
    decoderRef.current = null
    manifestRef.current = null
    assemblerRef.current = new ManifestAssembler()
    pendingDataRef.current = []
    attemptsRef.current = 0
    qualityRef.current = 0
    startRef.current = 0
    speedEpochRef.current = 0
    doneRef.current = false
    statsRef.current = { looks: 0, combinedWins: 0, superLooks: 0, superWins: 0, ms: 0, avgMs: 0, maxMs: 0, processed: 0, wasm: false, spatialSimd: false, webGpu: false, gpuSampleMs: 0, webGpuStatus: 'waiting', webGpuReason: 'waiting for manifest', workerPool: 0, turboPairs: 0, captureTargetFps: 0, timingFps: 0, timingSkips: 0, laneFrames: [0, 0], proc: 0, tracked: 0, phase: 'search', colorConfidence: 0, spatialBlur: 0, gpuCapture: false }
    runRef.current = { firstValidAt: 0, firstDataAt: 0, validFrames: 0 }
    diagRef.current = { manifest: 0, data: 0, dataUnique: 0, dataDuplicate: 0, dataRedundant: 0, solo: 0, soloFail: 0, manifestNull: 0, dataDropped: 0, dataBuffered: 0, manifestInvalid: 0, parts: '-' }
    setSnap(EMPTY)
    setResult(null)
    setDetected(null)
    lockTonePlayedRef.current = false
    cameraRef.current = null
    detectedRef.current = null
  }, [])

  const present = useCallback((kind: 'file' | 'text', name: string, mime: string, bytes: Uint8Array, verified = false, manifest: TransferManifest | null = manifestRef.current) => {
      doneRef.current = true
    playChannelTone('complete', soundEnabledRef.current)
    const started = runRef.current.firstDataAt || runRef.current.firstValidAt
    const seconds = started ? (performance.now() - started) / 1000 : 0
    const applicationGoodputKBs = seconds > 0 ? bytes.length / 1024 / seconds : 0
    const goodputKBs = seconds > 0 ? (manifest?.comp ?? bytes.length) / 1024 / seconds : 0
    const validFrameRate = attemptsRef.current ? runRef.current.validFrames / attemptsRef.current : 0
    const calibration = manifest ? assessOpticalLink({
      goodputKBs,
      validFrameRate,
      averageDecodeMs: statsRef.current.avgMs,
      chunkBytes: manifest.chunk,
      ldpcRate: manifest.rate,
      senderFps: manifest.fps,
      gridW: manifest.gridW,
      gridH: manifest.gridH,
      lanes: tileCountRef.current,
      colorConfidence: statsRef.current.colorConfidence,
    }) : null
    const benchmark = {
      seconds, goodputKBs, applicationGoodputKBs, validFrames: runRef.current.validFrames, attempts: attemptsRef.current, verified, calibration,
      report: JSON.stringify({
        report: 'LumaLink optical-transfer benchmark',
        timestamp: new Date().toISOString(),
        result: { name, mime, bytes: bytes.length, sha256Verified: verified },
        goodputKBs: Number(goodputKBs.toFixed(2)),
        opticalGoodputKBs: Number(goodputKBs.toFixed(2)),
        applicationGoodputKBs: Number(applicationGoodputKBs.toFixed(2)),
        transferSeconds: Number(seconds.toFixed(3)),
        validFrames: runRef.current.validFrames,
        workerReplies: attemptsRef.current,
        validFrameRate: Number(validFrameRate.toFixed(3)),
        camera: cameraRef.current,
        optical: manifest ? {
          protocolVersion: manifest.v,
          encoding: manifest.enc,
          grid: `${manifest.gridW}x${manifest.gridH}`,
          ldpcRate: manifest.rate,
          senderFps: manifest.fps ?? null,
          turboLanes: tileCountRef.current,
          chunks: manifest.k,
          chunkBytes: manifest.chunk,
          originalBytes: manifest.total,
          originalKiB: Number((manifest.total / 1024).toFixed(2)),
          packedBytes: manifest.comp,
          packedKiB: Number((manifest.comp / 1024).toFixed(2)),
          compressionRatio: Number((manifest.comp / Math.max(1, manifest.total)).toFixed(3)),
          compressed: manifest.compressed ?? true,
          zones: !!manifest.zones,
        } : null,
        decoder: {
          wasm: statsRef.current.wasm,
          wasmPipeline: statsRef.current.wasm ? 'f32-simd-direct' : 'js-fallback',
          sharedMemoryReady: globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined',
          spatialSimd: statsRef.current.spatialSimd,
          webGpu: statsRef.current.webGpu,
          gpuSampleMs: Number(statsRef.current.gpuSampleMs.toFixed(2)),
          webGpuStatus: statsRef.current.webGpuStatus,
          webGpuReason: statsRef.current.webGpuReason,
          workerPool: statsRef.current.workerPool,
          turboPairs: statsRef.current.turboPairs,
          captureTargetFps: Number(statsRef.current.captureTargetFps.toFixed(2)),
          timingFps: Number(statsRef.current.timingFps.toFixed(2)),
          timingSkips: statsRef.current.timingSkips,
          laneFrames: statsRef.current.laneFrames,
          lastDecodeMs: Number(statsRef.current.ms.toFixed(2)),
          averageDecodeMs: Number(statsRef.current.avgMs.toFixed(2)),
          maxDecodeMs: Number(statsRef.current.maxMs.toFixed(2)),
          workerFramesProcessed: statsRef.current.processed,
          processingMaxPx: statsRef.current.proc,
          trackedFrames: statsRef.current.tracked,
          phase: statsRef.current.phase,
          colorConfidence: Number(statsRef.current.colorConfidence.toFixed(3)),
          spatialBlur: Number(statsRef.current.spatialBlur.toFixed(3)),
          gpuCapture: statsRef.current.gpuCapture,
          softLooks: statsRef.current.looks,
          combinedWins: statsRef.current.combinedWins,
          superResLooks: statsRef.current.superLooks,
          superResWins: statsRef.current.superWins,
        },
        fountain: decoderRef.current ? {
          repairProfile: manifest?.v && manifest.v >= 9 ? '8:1-mixed-packed128' : manifest?.v === 8 ? '4:1-wide-packed128' : 'legacy',
          receivedEquations: decoderRef.current.receivedEquations,
          tailSolverAttempts: decoderRef.current.tailSolverAttempts,
          tailSolverChunks: decoderRef.current.tailSolverChunks,
          tailSolverMs: Number(decoderRef.current.tailSolverMs.toFixed(2)),
        } : null,
        calibration,
        counters: diagRef.current,
        detected: detectedRef.current,
      }, null, 2),
    }
    // Keep the receipt on the receiver itself. No sender/server connection is
    // required, and transferred bytes are never sent over any network path.
    void saveDiagnosticReport(benchmark.report)
    setActive(false)
    if (kind === 'text') {
      setResult({ name, mime, kind, bytes, text: new TextDecoder().decode(bytes), benchmark })
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      setResult({ name, mime, kind, bytes, url, benchmark })
    }
  }, [])

  const finish = useCallback(async () => {
    const m = manifestRef.current
    const dec = decoderRef.current
    if (!m || !dec) return
    doneRef.current = true
    try {
      const bytes = await finishTransfer(dec.reconstruct(), m)
      present(m.kind, m.name, m.mime, bytes, !!m.sha256, m)
    } catch (error) {
      doneRef.current = false
      message.error(error instanceof Error ? error.message : 'File verification failed')
    }
  }, [present])

  const acceptData = useCallback((parsed: ParsedFrame): boolean => {
    const dec = decoderRef.current
    if (!dec) return false
    const started = runRef.current.firstDataAt || performance.now()
    if (!runRef.current.firstDataAt) runRef.current.firstDataAt = started
    if (startRef.current === 0) startRef.current = started
    const equationsBefore = dec.receivedEquations
    const useful = dec.addFrame(parsed.seed, parsed.payload)
    if (dec.receivedEquations === equationsBefore) diagRef.current.dataDuplicate++
    else {
      diagRef.current.dataUnique++
      // A unique repair frame can be mathematically redundant after other
      // equations have already closed its sources.  It is not a camera repeat.
      if (!useful) diagRef.current.dataRedundant++
    }
    if (dec.isComplete) void finish()
    return true
  }, [finish])

    const onScan = useCallback((parsed: ParsedFrame | null) => {

    if (doneRef.current) return
    attemptsRef.current++
    // Exponential moving average of scan success → connection quality.
    qualityRef.current = qualityRef.current * 0.9 + (parsed ? 0.1 : 0)
    if (!parsed) return
    runRef.current.validFrames++
    if (!runRef.current.firstValidAt) runRef.current.firstValidAt = performance.now()
    const d = diagRef.current

    // Self-contained single frame → reconstruct immediately, done.
    if (parsed.type === FRAME_TYPE_SOLO) {
      d.solo++
      void parseSolo(parsed.payload).then(solo => {
        if (solo) present(solo.kind, solo.name, solo.mime, solo.bytes, true)
        else { d.soloFail++; message.error('Static-frame verification failed') }
      })
      return
    }

    if (parsed.type === FRAME_TYPE_MANIFEST) {
      d.manifest++
      if (parsed.payload.length >= 2) d.parts = `${parsed.payload[0] + 1}/${parsed.payload[1]}`
      const m = assemblerRef.current.add(parsed.payload, detectedRef.current ?? undefined)
      if (!m) { d.manifestNull++; return }
      if (!isValidManifest(m)) { d.manifestInvalid++; return }
      if (!manifestRef.current || manifestRef.current.id !== m.id) {
        manifestRef.current = m
        setManifestEpoch(epoch => epoch + 1)
        // v8 makes every repair medium-wide; v9 restores the field-proven
        // alternating graph. Keep every older mapping intact so interrupted
        // transfers remain decodable after updating this receiver.
        decoderRef.current?.dispose()
        const nextDecoder = new FountainDecoder(m.k, m.chunk, m.v >= 3, m.v === 8 ? 1 : m.v >= 4 ? 2 : 4, () => {
          if (decoderRef.current === nextDecoder && nextDecoder.isComplete) void finish()
        })
        decoderRef.current = nextDecoder
        const early = pendingDataRef.current
        pendingDataRef.current = []
        for (const frame of early) acceptData(frame)
        if (early.length) speedEpochRef.current++
      }
      return
    }

    // Data frame.
    d.data++
    // Start end-to-end timing as soon as the camera sees the first data frame,
    // even if the manifest arrives later. Otherwise buffered data inflate both
    // the apparent first burst and the reported whole-transfer goodput.
    if (!runRef.current.firstDataAt) {
      const started = performance.now()
      runRef.current.firstDataAt = started
      if (startRef.current === 0) startRef.current = started
    }
    if (acceptData(parsed)) return
    // Worker replies can arrive out of order: keep early valid data until the
    // manifest gives us K/chunk size instead of throwing away source frames.
    if (pendingDataRef.current.length < 192) {
      pendingDataRef.current.push(parsed)
      d.dataBuffered++
    } else {
      d.dataDropped++
    }
  }, [acceptData])

  // Publish a display snapshot at a steady rate (keeps rendering cheap).
    useEffect(() => {
   
    if (!active) return
    let lastAttempts = attemptsRef.current
    let lastUnique = decoderRef.current?.uniqueChunks ?? 0
    let lastTs = performance.now()
    let lastSpeedEpoch = speedEpochRef.current
    let rollingSpeed = 0
    const id = window.setInterval(() => {
      const dec = decoderRef.current
      const m = manifestRef.current
      const unique = dec?.uniqueChunks ?? 0
      const k = m?.k ?? 0
      const now = performance.now()
      if (lastSpeedEpoch !== speedEpochRef.current) {
        lastSpeedEpoch = speedEpochRef.current
        lastUnique = unique
        lastTs = now
        rollingSpeed = 0
      }
      const elapsed = startRef.current ? (performance.now() - startRef.current) / 1000 : 0
      const bytes = unique * (m?.chunk ?? 0)
      // Fountain elimination can release several already-received source chunks
      // at once. That is a real user-visible progress burst, but it is distinct
      // from the whole-transfer goodput shown alongside it in the overlay.
      const averageSpeed = elapsed > 3 ? bytes / 1024 / elapsed : 0
      const intervalSeconds = Math.max(0.001, (now - lastTs) / 1000)
      const instantSpeed = (unique - lastUnique) * (m?.chunk ?? 0) / 1024 / intervalSeconds
      rollingSpeed = instantSpeed > 0 ? rollingSpeed * 0.55 + instantSpeed * 0.45 : rollingSpeed * 0.82
      const rate = (averageSpeed * 1024) / Math.max(1, m?.chunk ?? 1)
      const eta = rate > 0 && k > 0 ? Math.max(0, (k - unique) / rate) : -1
      const scanRate = (attemptsRef.current - lastAttempts) / intervalSeconds
      lastAttempts = attemptsRef.current; lastTs = now; lastUnique = unique
      setSnap({
        k, unique,
        quality: Math.min(1, qualityRef.current * 10), // EMA scaled back to 0..1
        speed: rollingSpeed, averageSpeed, eta,
        manifestSeen: !!m,
        attempts: attemptsRef.current,
        scanRate,
        combinedWins: statsRef.current.combinedWins,
      })
      setDiag({ ...diagRef.current, ms: Math.round(statsRef.current.ms), wasm: statsRef.current.wasm, webGpu: statsRef.current.webGpu, webGpuStatus: statsRef.current.webGpuStatus, webGpuReason: statsRef.current.webGpuReason, laneFrames: statsRef.current.laneFrames, phase: statsRef.current.phase, colorConfidence: statsRef.current.colorConfidence })
    }, 400)
    return () => clearInterval(id)
  }, [active])

  const pct = snap.k > 0 ? Math.round((snap.unique / snap.k) * 100) : 0
  if (result) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <Result
          status="success"
          icon={<CheckCircleOutlined />}
          title="اكتمل الاستقبال بنجاح"
          subTitle={`${result.name} — ${(result.bytes.length / 1024).toFixed(1)} كيلوبايت`}
        />
        {result.benchmark && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`Optical: ${result.benchmark.goodputKBs.toFixed(1)} KB/s · File effective: ${result.benchmark.applicationGoodputKBs.toFixed(1)} KB/s · ${result.benchmark.seconds.toFixed(2)} s`}
            description={`Valid frames: ${result.benchmark.validFrames}/${result.benchmark.attempts}${result.benchmark.verified ? ' · SHA-256 verified' : ''}`}
          />
        )}
        {result.benchmark && (
          <Card size="small" title="Benchmark report" style={{ marginBottom: 16 }}>
            <Space wrap style={{ marginBottom: 10 }}>
              <Tag color="blue">File: {(result.bytes.length / 1024).toFixed(2)} KiB</Tag>
              <Tag color="green">Optical: {result.benchmark.goodputKBs.toFixed(1)} KB/s</Tag>
              <Tag color="cyan">File effective: {result.benchmark.applicationGoodputKBs.toFixed(1)} KB/s</Tag>
              <Tag color={result.benchmark.verified ? 'success' : 'warning'}>{result.benchmark.verified ? 'SHA-256 verified' : 'No SHA-256'}</Tag>
            </Space>
            {result.benchmark.calibration && (
              <Alert
                type={result.benchmark.calibration.status === 'clean' ? 'success' : result.benchmark.calibration.status === 'stable' ? 'info' : 'warning'}
                showIcon
                message={`${result.benchmark.calibration.label} · كفاءة ${Math.round(result.benchmark.calibration.utilization * 100)}٪`}
                description={result.benchmark.calibration.recommendation}
                style={{ marginBottom: 10 }}
              />
            )}
            <Input.TextArea value={result.benchmark.report} rows={12} readOnly style={{ fontFamily: 'monospace', fontSize: 11 }} />
            <Button
              type="primary"
              icon={<CopyOutlined />}
              style={{ marginTop: 10 }}
              onClick={() => navigator.clipboard?.writeText(result.benchmark?.report ?? '').then(() => message.success('Benchmark report copied'))}
            >
              Copy benchmark report
            </Button>
          </Card>
        )}
        {result.kind === 'text' ? (
          <Card>
            <Input.TextArea value={result.text} rows={8} readOnly />
            <Space style={{ marginTop: 12 }}>
              <Button icon={<CopyOutlined />} onClick={() => navigator.clipboard?.writeText(result.text ?? '')}>
                نسخ النص
              </Button>
              <Button icon={<ReloadOutlined />} onClick={reset}>استقبال جديد</Button>
            </Space>
          </Card>
        ) : (
          <Card style={{ textAlign: 'center' }}>
            <Space direction="vertical" size="large">
              <a href={result.url} download={result.name}>
                <Button type="primary" size="large" icon={<DownloadOutlined />}>
                  تنزيل {result.name}
                </Button>
              </a>
              <Button icon={<ReloadOutlined />} onClick={reset}>استقبال جديد</Button>
            </Space>
          </Card>
        )}
      </div>
    )
  }

  if (active) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000', overflow: 'hidden' }}>
        <CameraReader
          auto
          active={active}
          tileCount={tileCount}
          autoLayout={layoutAuto}
          manifest={manifestRef.current}
          onScan={onScan}
          onResolution={(w, h, fps) => { const camera = { w, h, ...(fps ? { fps } : {}) }; cameraRef.current = camera; setCamRes(camera) }}
          onStats={(s) => { statsRef.current = s }}
          onDetect={(spec) => { detectedRef.current = spec; setDetected(spec); if (!lockTonePlayedRef.current) { lockTonePlayedRef.current = true; playChannelTone('lock', soundEnabledRef.current) } }}
          onLayoutDetect={(lanes) => { if (layoutAuto) setTileCount(lanes) }}
        />

        <div className={`opt-rx-lock ${detected ? 'locked' : ''}`} aria-hidden="true"><i /><i /><b /></div>
        {/* Top overlay: detection status */}
        <div style={{ position: 'absolute', top: 8, left: 8, right: 110, zIndex: 10, pointerEvents: 'none' }}>
          <div style={{
            background: detected ? 'rgba(22,119,55,0.85)' : 'rgba(0,0,0,0.6)',
            color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {detected ? <CheckCircleOutlined /> : <CameraOutlined spin />}
            <span>{detected
              ? `${ENC_LABEL[detected.enc]} · ${detected.gridW}×${detected.gridH}${tileCount === 2 ? ' · Turbo ×2' : ''}${camRes ? ` · ${camRes.w}×${camRes.h}` : ''}`
              : `يبحث عن المصفوفة…${camRes ? ` (${camRes.w}×${camRes.h})` : ''}`}</span>
            {diag.wasm && <Tag color="green" style={{ margin: 0, fontSize: 11 }}>WASM</Tag>}
            {diag.webGpu && <Tag color="purple" style={{ margin: 0, fontSize: 11 }}>WebGPU</Tag>}
            {!diag.webGpu && diag.webGpuStatus === 'probing' && <Tag color="geekblue" title={diag.webGpuReason} style={{ margin: 0, fontSize: 11 }}>WebGPU فحص</Tag>}
            {!diag.webGpu && (diag.webGpuStatus === 'unavailable' || diag.webGpuStatus === 'rejected') && <Tag color="orange" title={diag.webGpuReason} style={{ margin: 0, fontSize: 11 }}>CPU · WebGPU غير فعّال</Tag>}
            {tileCount === 2 && <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>L1 {diag.laneFrames[0]} · L2 {diag.laneFrames[1]}</Tag>}
            {snap.unique > 0 && <Tag color="success" style={{ margin: 0, fontSize: 11 }}>نقل فعّال</Tag>}
            {detected && <Tag color={diag.phase === 'payload' ? 'cyan' : 'gold'} style={{ margin: 0, fontSize: 11 }}>
              {diag.phase === 'payload' ? 'CV Lock' : 'تتبّع مبدئي'}
            </Tag>}
          </div>
        </div>

        {/* Bottom overlay: progress + stats */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10 }}>
          <div style={{
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
            color: '#fff', borderRadius: '10px 10px 0 0', padding: '4px 10px 6px',
          }}>
            <Progress
              percent={pct} status={pct >= 100 ? 'success' : 'active'} size="small"
              strokeColor={pct >= 100 ? '#52c41a' : '#1677ff'}
              trailColor="rgba(255,255,255,0.15)"
              format={p => <span style={{ color: '#fff', fontSize: 11 }}>{p}٪</span>}
              style={{ marginBottom: 2 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'rgba(255,255,255,0.85)', gap: 6 }}>
              <span>{snap.unique}{snap.k ? `/${snap.k}` : ''}</span>
              <span title="Instant recovery speed / whole-transfer goodput">{snap.speed > 0 ? `لحظي ${snap.speed.toFixed(1)} · كلي ${snap.averageSpeed.toFixed(1)} KB/s` : '…'}</span>
              <span>{Math.round(snap.scanRate)} fps</span>
              <Tag title="نسبة لقطات الكاميرا التي اجتازت CRC/LDPC، وليست جودة الصورة" color={snap.unique > 0 ? 'success' : qualityColor(snap.quality)} style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                {snap.unique > 0 ? 'يستقبل' : `${Math.round(snap.quality * 100)}٪`}
              </Tag>
              <span title={detected?.enc === 'bw' ? 'ثبات عينات الأبيض/الأسود' : 'متوسط ثقة لون الخلايا'} style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)' }}>
                {Math.round(diag.colorConfidence * 100)}% {detected?.enc === 'bw' ? 'إشارة' : 'لون'}
              </span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>{diag.ms}ms</span>
              <Button size="small" icon={<ReloadOutlined />} onClick={reset}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', height: 22, fontSize: 11, padding: '0 6px' }}>إيقاف</Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="opt-page" style={{ maxWidth: 640 }}>
      <section className="opt-hero">
        <div className="opt-constellation" aria-hidden="true"><i /><i /><i /><i /><i /></div><div className="opt-orbit opt-orbit-receive" aria-hidden="true"><i /><i /><b>◉</b></div>
        <span className="opt-eyebrow">LUMALINK / RECEIVE CHANNEL</span>
        <Title>استقبل عبر الضوء</Title>
        <Paragraph type="secondary">افتح الكاميرا ثم وجّهها إلى القناة المعروضة.</Paragraph>
      </section>

      {!active && (
        <Card className="opt-card opt-panel opt-receive-panel" bordered={false}>
          <div className="opt-panel-cap"><Text className="opt-section-label">تجهيز ماسح القناة</Text><span>RX</span></div>
          <div className="opt-receive-mode">
            <Segmented
              block
              value={layoutAuto ? 'auto' : tileCount}
              onChange={value => {
                if (value === 'auto') setLayoutAuto(true)
                else { setLayoutAuto(false); setTileCount(value as 1 | 2) }
              }}
              options={[
                { label: 'تلقائي', value: 'auto' },
                { label: 'مصفوفة واحدة', value: 1 },
                { label: 'Turbo ×2', value: 2 },
              ]}
            />
          </div>
          <div className="opt-setting-row opt-sound-control"><div><Text strong>نبضات القناة</Text><Text type="secondary">صوت قصير عند قفل الإشارة واكتمال النقل.</Text></div><Switch checked={soundEnabled} onChange={setSoundEnabled} /></div>
          <Button type="primary" size="large" block className="opt-send-button" icon={<CameraOutlined />} onClick={() => { reset(); setActive(true) }}>
            فتح كاميرا الاستقبال
          </Button>
        </Card>
      )}
    </div>
  )
}

function qualityColor(q: number): string {
  if (q >= 0.5) return 'success'
  if (q >= 0.2) return 'warning'
  return 'error'
}
