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
  unique: number       // fully reconstructed source chunks
  rank: number         // innovative GF(2) equations (true transfer progress)
  rankExact: boolean
  quality: number      // 0..1 rolling valid-scan rate
  speed: number        // KB/s instantaneous recovered-data rate
  averageSpeed: number // KB/s since first data frame
  eta: number          // seconds remaining (-1 = unknown)
  manifestSeen: boolean
  attempts: number
  scanRate: number     // camera scans processed per second
  combinedWins: number // frames recovered thanks to soft-combining ≥2 looks
}

interface TransferTimelineSample {
  second: number
  intervalSeconds: number
  phase: 'search' | 'bootstrap' | 'payload' | 'complete'
  manifestSeen: boolean
  k: number
  uniqueChunks: number
  missingChunks: number
  decodedChunksDelta: number
  decodedKBps: number
  innovativeRank: number
  rankMissing: number
  rankDelta: number
  rankKBps: number
  rankExact: boolean
  equations: number
  equationsDelta: number
  equationRate: number
  attempts: number
  attemptsDelta: number
  scanRate: number
  validFrames: number
  validFramesDelta: number
  intervalValidRate: number
  dataFrames: number
  uniqueDataFrames: number
  uniqueDataFramesDelta: number
  duplicateDataFrames: number
  duplicateDataFramesDelta: number
  redundantDataFrames: number
  redundantDataFramesDelta: number
  manifestFrames: number
  manifestFramesDelta: number
  workerFramesProcessed: number
  workerFramesDelta: number
  decodeMs: number
  averageDecodeMs: number
  maxDecodeMs: number
  workerPool: number
  turboPairs: number
  captureTargetFps: number
  senderTimingFps: number
  timingSkips: number
  timingSkipsDelta: number
  laneFrames: [number, number]
  laneFramesDelta: [number, number]
  quality: number
  colorConfidence: number
  spatialBlur: number
  processingPixels: number
  trackedFrames: number
  combinedWins: number
  tailSolverAttempts: number
  tailSolverChunks: number
  signals: string[]
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

const EMPTY: Snapshot = { k: 0, unique: 0, rank: 0, rankExact: true, quality: 0, speed: 0, averageSpeed: 0, eta: -1, manifestSeen: false, attempts: 0, scanRate: 0, combinedWins: 0 }

const ENC_LABEL: Record<Encoding, string> = {
  bw: 'أبيض وأسود', color8: '8 ألوان', color16: '16 لون', color32: '32 لون', color64: '64 لون',
}

function summarizeTransferTimeline(samples: TransferTimelineSample[]) {
  const signalSeconds: Record<string, number> = {}
  let longestNoDecodedSeconds = 0
  let currentNoDecodedSeconds = 0
  let longestNoRankSeconds = 0
  let currentNoRankSeconds = 0
  for (const sample of samples) {
    for (const signal of sample.signals) signalSeconds[signal] = Number(((signalSeconds[signal] ?? 0) + sample.intervalSeconds).toFixed(3))
    if (sample.phase === 'payload' && sample.decodedChunksDelta === 0) {
      currentNoDecodedSeconds += sample.intervalSeconds
      longestNoDecodedSeconds = Math.max(longestNoDecodedSeconds, currentNoDecodedSeconds)
    } else currentNoDecodedSeconds = 0
    if (sample.phase === 'payload' && sample.rankDelta === 0) {
      currentNoRankSeconds += sample.intervalSeconds
      longestNoRankSeconds = Math.max(longestNoRankSeconds, currentNoRankSeconds)
    } else currentNoRankSeconds = 0
  }
  return {
    samples: samples.length,
    durationSeconds: samples.length ? samples[samples.length - 1].second : 0,
    longestNoDecodedSeconds: Number(longestNoDecodedSeconds.toFixed(3)),
    longestNoRankSeconds: Number(longestNoRankSeconds.toFixed(3)),
    maxDecodeMs: samples.reduce((max, sample) => Math.max(max, sample.decodeMs), 0),
    maxScanRate: samples.reduce((max, sample) => Math.max(max, sample.scanRate), 0),
    maxDecodedKBps: samples.reduce((max, sample) => Math.max(max, sample.decodedKBps), 0),
    maxRankKBps: samples.reduce((max, sample) => Math.max(max, sample.rankKBps), 0),
    signalSeconds,
  }
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
  const timelineRef = useRef<TransferTimelineSample[]>([])
  const timelineStartedAtRef = useRef(0)
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
    timelineRef.current = []
    timelineStartedAtRef.current = 0
    setSnap(EMPTY)
    setResult(null)
    setDetected(null)
    lockTonePlayedRef.current = false
    cameraRef.current = null
    detectedRef.current = null
  }, [])

  const recordTimelineSample = useCallback((complete = false) => {
    const now = performance.now()
    if (!timelineStartedAtRef.current) timelineStartedAtRef.current = now
    const previous = timelineRef.current[timelineRef.current.length - 1]
    const elapsed = Math.max(0, (now - timelineStartedAtRef.current) / 1000)
    const intervalSeconds = Math.max(0.001, previous ? elapsed - previous.second : elapsed || 1)
    const dec = decoderRef.current
    const m = manifestRef.current
    const stats = statsRef.current
    const diag = diagRef.current
    const uniqueChunks = dec?.uniqueChunks ?? 0
    const innovativeRank = dec?.innovativeRank ?? 0
    const equations = dec?.receivedEquations ?? 0
    const attemptsDelta = attemptsRef.current - (previous?.attempts ?? 0)
    const validFramesDelta = runRef.current.validFrames - (previous?.validFrames ?? 0)
    const decodedChunksDelta = uniqueChunks - (previous?.uniqueChunks ?? 0)
    const rankDelta = innovativeRank - (previous?.innovativeRank ?? 0)
    const uniqueDataFramesDelta = diag.dataUnique - (previous?.uniqueDataFrames ?? 0)
    const duplicateDataFramesDelta = diag.dataDuplicate - (previous?.duplicateDataFrames ?? 0)
    const redundantDataFramesDelta = diag.dataRedundant - (previous?.redundantDataFrames ?? 0)
    const manifestFramesDelta = diag.manifest - (previous?.manifestFrames ?? 0)
    const workerFramesDelta = stats.processed - (previous?.workerFramesProcessed ?? 0)
    const timingSkipsDelta = stats.timingSkips - (previous?.timingSkips ?? 0)
    const laneFramesDelta: [number, number] = [
      stats.laneFrames[0] - (previous?.laneFrames[0] ?? 0),
      stats.laneFrames[1] - (previous?.laneFrames[1] ?? 0),
    ]
    const signals: string[] = []
    if (previous) {
      if (workerFramesDelta === 0 && attemptsDelta === 0) signals.push('capture-or-scheduler-stall')
      if (attemptsDelta > 0 && validFramesDelta === 0) signals.push('optical-or-ldpc-failure')
      if (timingSkipsDelta > 0 || duplicateDataFramesDelta > 0) signals.push('duplicate-or-phase-aliasing')
      if (manifestFramesDelta > 0 && uniqueDataFramesDelta === 0) signals.push('manifest-overhead')
      if (equations - (previous?.equations ?? 0) > 0 && decodedChunksDelta === 0) signals.push('fountain-accumulating')
      if (equations - (previous?.equations ?? 0) > 0 && rankDelta === 0) signals.push('rank-stall-dependent-equations')
      if (decodedChunksDelta > Math.max(2, equations - (previous?.equations ?? 0))) signals.push('fountain-release-burst')
      if (stats.timingFps > 0 && stats.captureTargetFps + 0.5 < stats.timingFps) signals.push('receiver-processing-throttle')
    }
    timelineRef.current.push({
      second: Number(elapsed.toFixed(3)),
      intervalSeconds: Number(intervalSeconds.toFixed(3)),
      phase: complete ? 'complete' : stats.phase,
      manifestSeen: !!m,
      k: m?.k ?? 0,
      uniqueChunks,
      missingChunks: Math.max(0, (m?.k ?? 0) - uniqueChunks),
      decodedChunksDelta,
      decodedKBps: Number((decodedChunksDelta * (m?.chunk ?? 0) / 1024 / intervalSeconds).toFixed(3)),
      innovativeRank,
      rankMissing: Math.max(0, (m?.k ?? 0) - innovativeRank),
      rankDelta,
      rankKBps: Number((rankDelta * (m?.chunk ?? 0) / 1024 / intervalSeconds).toFixed(3)),
      rankExact: dec?.rankIsExact ?? true,
      equations,
      equationsDelta: equations - (previous?.equations ?? 0),
      equationRate: Number(((equations - (previous?.equations ?? 0)) / intervalSeconds).toFixed(3)),
      attempts: attemptsRef.current,
      attemptsDelta,
      scanRate: Number((attemptsDelta / intervalSeconds).toFixed(3)),
      validFrames: runRef.current.validFrames,
      validFramesDelta,
      intervalValidRate: Number((validFramesDelta / Math.max(1, attemptsDelta)).toFixed(3)),
      dataFrames: diag.data,
      uniqueDataFrames: diag.dataUnique,
      uniqueDataFramesDelta,
      duplicateDataFrames: diag.dataDuplicate,
      duplicateDataFramesDelta,
      redundantDataFrames: diag.dataRedundant,
      redundantDataFramesDelta,
      manifestFrames: diag.manifest,
      manifestFramesDelta,
      workerFramesProcessed: stats.processed,
      workerFramesDelta,
      decodeMs: Number(stats.ms.toFixed(2)),
      averageDecodeMs: Number(stats.avgMs.toFixed(2)),
      maxDecodeMs: Number(stats.maxMs.toFixed(2)),
      workerPool: stats.workerPool,
      turboPairs: stats.turboPairs,
      captureTargetFps: Number(stats.captureTargetFps.toFixed(2)),
      senderTimingFps: Number(stats.timingFps.toFixed(2)),
      timingSkips: stats.timingSkips,
      timingSkipsDelta,
      laneFrames: [...stats.laneFrames],
      laneFramesDelta,
      quality: Number(Math.min(1, qualityRef.current * 10).toFixed(3)),
      colorConfidence: Number(stats.colorConfidence.toFixed(3)),
      spatialBlur: Number(stats.spatialBlur.toFixed(3)),
      processingPixels: stats.proc,
      trackedFrames: stats.tracked,
      combinedWins: stats.combinedWins,
      tailSolverAttempts: dec?.tailSolverAttempts ?? 0,
      tailSolverChunks: dec?.tailSolverChunks ?? 0,
      signals,
    })
  }, [])

  const present = useCallback((kind: 'file' | 'text', name: string, mime: string, bytes: Uint8Array, verified = false, manifest: TransferManifest | null = manifestRef.current) => {
    doneRef.current = true
    recordTimelineSample(true)
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
          repairProfile: manifest?.v && manifest.v >= 10 ? '1:1-balanced-mixed-packed128' : manifest?.v === 9 ? '8:1-mixed-packed128' : manifest?.v === 8 ? '4:1-wide-packed128' : 'legacy',
          receivedEquations: decoderRef.current.receivedEquations,
          innovativeRank: decoderRef.current.innovativeRank,
          rankExact: decoderRef.current.rankIsExact,
          dependentEquations: decoderRef.current.dependentEquations,
          tailSolverAttempts: decoderRef.current.tailSolverAttempts,
          tailSolverChunks: decoderRef.current.tailSolverChunks,
          tailSolverMs: Number(decoderRef.current.tailSolverMs.toFixed(2)),
        } : null,
        calibration,
        counters: diagRef.current,
        detected: detectedRef.current,
        timelineSamplingSeconds: 1,
        timelineSummary: summarizeTransferTimeline(timelineRef.current),
        timeline: timelineRef.current,
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
  }, [recordTimelineSample])

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
    let lastRank = decoderRef.current?.innovativeRank ?? 0
    let lastTs = performance.now()
    let lastSpeedEpoch = speedEpochRef.current
    let rollingSpeed = 0
    const id = window.setInterval(() => {
      const dec = decoderRef.current
      const m = manifestRef.current
      const unique = dec?.uniqueChunks ?? 0
      const rank = dec?.innovativeRank ?? 0
      const k = m?.k ?? 0
      const now = performance.now()
      if (lastSpeedEpoch !== speedEpochRef.current) {
        lastSpeedEpoch = speedEpochRef.current
        lastRank = rank
        lastTs = now
        rollingSpeed = 0
      }
      const elapsed = startRef.current ? (performance.now() - startRef.current) / 1000 : 0
      const bytes = rank * (m?.chunk ?? 0)
      // Rank grows when a mathematically independent equation arrives, even if
      // peeling has not released its source chunks yet. This is the true smooth
      // channel progress; decoded chunks remain visible as a secondary counter.
      const averageSpeed = elapsed > 3 ? bytes / 1024 / elapsed : 0
      const intervalSeconds = Math.max(0.001, (now - lastTs) / 1000)
      const instantSpeed = (rank - lastRank) * (m?.chunk ?? 0) / 1024 / intervalSeconds
      rollingSpeed = instantSpeed > 0 ? rollingSpeed * 0.55 + instantSpeed * 0.45 : rollingSpeed * 0.82
      const rate = (averageSpeed * 1024) / Math.max(1, m?.chunk ?? 1)
      const eta = rate > 0 && k > 0 ? Math.max(0, (k - rank) / rate) : -1
      const scanRate = (attemptsRef.current - lastAttempts) / intervalSeconds
      lastAttempts = attemptsRef.current; lastTs = now; lastRank = rank
      setSnap({
        k, unique, rank, rankExact: dec?.rankIsExact ?? true,
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

  // Preserve a full second-by-second history separately from the faster UI
  // refresh. This timeline is embedded in the locally saved completion report.
  useEffect(() => {
    if (!active) return
    if (!timelineStartedAtRef.current) timelineStartedAtRef.current = performance.now()
    recordTimelineSample()
    const id = window.setInterval(() => recordTimelineSample(), 1000)
    return () => clearInterval(id)
  }, [active, recordTimelineSample])

  const pct = snap.k > 0 ? Math.round((snap.rank / snap.k) * 100) : 0
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
            {snap.rank > 0 && <Tag color="success" style={{ margin: 0, fontSize: 11 }}>نقل فعّال</Tag>}
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
              <span title="الرتبة المستقلة / القطع المحلولة">رتبة {snap.rank}{snap.k ? `/${snap.k}` : ''} · محلول {snap.unique}</span>
              <span title="Instant recovery speed / whole-transfer goodput">{snap.speed > 0 ? `لحظي ${snap.speed.toFixed(1)} · كلي ${snap.averageSpeed.toFixed(1)} KB/s` : '…'}</span>
              <span>{Math.round(snap.scanRate)} fps</span>
              <Tag title="نسبة لقطات الكاميرا التي اجتازت CRC/LDPC، وليست جودة الصورة" color={snap.rank > 0 ? 'success' : qualityColor(snap.quality)} style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                {snap.rank > 0 ? (snap.rankExact ? 'رتبة دقيقة' : 'رتبة تقديرية') : `${Math.round(snap.quality * 100)}٪`}
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
