import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Space, Tag, Tooltip } from 'antd'
import { FullscreenExitOutlined, FullscreenOutlined, PauseOutlined, PlayCircleOutlined } from '@ant-design/icons'
import VisualMatrix, { type VisualMatrixHandle } from './VisualMatrix'
import type { EncodingSpec, ZoneMap } from '../services/visualCodec'
import type { BarcodeData, OpticalLaneCount } from '../services/metaBarcode'
import type { TransferControl } from '../services/controlBarcode'

interface Props {
  frameAt: (index: number) => Uint8Array
  frameCount: number
  spec: EncodingSpec
  fps: number
  zoneMap?: ZoneMap
  barcode: BarcodeData
  control?: TransferControl
  segmented?: boolean
  lanes: Exclude<OpticalLaneCount, 1>
}

/**
 * Multiple independent optical lanes arranged in two columns. Four lanes use
 * two rows and six lanes use three, matching a landscape sender screen while
 * keeping every tile square.
 *
 * Both canvases show disjoint indexes from the same fountain carousel. This is
 * deliberately not a QR clone and not two separate file transfers: one decoder
 * can reconstruct the file from source/repair frames recovered from either lane.
 */
export default function TurboMatrix({ frameAt, frameCount, spec, fps, zoneMap, barcode, control, segmented, lanes }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const laneRefs = useRef<Array<VisualMatrixHandle | null>>([])
  const tickRef = useRef(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const el = stageRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch { /* browser can reject fullscreen outside a user gesture */ }
  }, [])

  // One imperative clock draws both canvases inside the same animation callback.
  // This avoids both lane drift and a full React tree render on every optical tick;
  // the latter reduced a nominal 12fps sender to roughly the receiver cadence.
  useEffect(() => {
    tickRef.current = 0
    for (const lane of laneRefs.current) lane?.drawFrame(0)
  }, [frameCount, frameAt, lanes])

  useEffect(() => {
    if (!playing || frameCount <= 1) return
    let raf = 0
    const interval = 1000 / fps
    const tickCount = Math.max(1, Math.ceil(frameCount / lanes))
    let nextPaintAt = performance.now() + interval
    const paint = (now: number) => {
      if (now >= nextPaintAt) {
        // Advance only inside the browser's pre-paint callback. setInterval could
        // upload a symbol that the compositor never displayed, creating fountain
        // holes even though the sender counter advanced.
        tickRef.current = (tickRef.current + 1) % tickCount
        for (const lane of laneRefs.current) lane?.drawFrame(tickRef.current)
        if (stageRef.current) {
          stageRef.current.dataset.opticalTick = String(tickRef.current)
          stageRef.current.dataset.paintedAt = now.toFixed(2)
        }
        nextPaintAt += interval
        // Preserve symbols across a real UI pause instead of bursting several
        // unseen updates into one refresh.
        if (nextPaintAt < now) nextPaintAt = now + interval
      }
      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(raf)
  }, [playing, fps, frameCount, frameAt, lanes])

  return (
    <div ref={stageRef} className="gd-turbo-stage">
      <div className="gd-turbo-grid" style={{ '--gd-lanes': lanes, '--gd-rows': Math.ceil(lanes / 2) } as CSSProperties} aria-label={`LumaLink Turbo ${lanes} optical lanes`}>
        {Array.from({ length: lanes }, (_, lane) => (
          <VisualMatrix
            key={lane}
            ref={value => { laneRefs.current[lane] = value }}
            compact
            frameAt={frameAt}
            frameCount={frameCount}
            spec={spec}
            fps={fps}
            zoneMap={zoneMap}
            barcode={{ ...barcode, lanes }}
            control={control}
            segmented={segmented}
            frameOffset={lane}
            frameStride={lanes}
            frameIndex={0}
            lane={lane}
          />
        ))}
      </div>
      <Space className="gd-turbo-controls" size={8} wrap>
        <Tag color="magenta">Turbo ×{lanes}</Tag>
        <Tag color="blue">{spec.enc}</Tag>
        <Tag color="cyan">{spec.gridW}×{spec.gridH}</Tag>
        <Tag color="green">CV Lock ثابت</Tag>
        <Tag color="green">{fps} ticks/s · {fps * lanes} frames/s</Tag>
        <Button size="small" icon={playing ? <PauseOutlined /> : <PlayCircleOutlined />} onClick={() => setPlaying(v => !v)}>
          {playing ? 'إيقاف' : 'تشغيل'}
        </Button>
        <Tooltip title={isFullscreen ? 'خروج من ملء الشاشة' : 'ملء الشاشة'}>
          <Button size="small" type={isFullscreen ? 'default' : 'primary'} icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={toggleFullscreen}>
            {isFullscreen ? 'خروج' : 'ملء الشاشة'}
          </Button>
        </Tooltip>
      </Space>
    </div>
  )
}
