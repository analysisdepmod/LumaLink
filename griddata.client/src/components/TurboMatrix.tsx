import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Space, Tag, Tooltip } from 'antd'
import { FullscreenExitOutlined, FullscreenOutlined, PauseOutlined, PlayCircleOutlined } from '@ant-design/icons'
import VisualMatrix from './VisualMatrix'
import type { EncodingSpec, ZoneMap } from '../services/visualCodec'
import type { BarcodeData } from '../services/metaBarcode'

interface Props {
  frameAt: (index: number) => Uint8Array
  frameCount: number
  spec: EncodingSpec
  fps: number
  zoneMap?: ZoneMap
  barcode: BarcodeData
}

/**
 * Two independent optical lanes on a landscape display.
 *
 * Both canvases show disjoint indexes from the same fountain carousel. This is
 * deliberately not a QR clone and not two separate file transfers: one decoder
 * can reconstruct the file from source/repair frames recovered from either lane.
 */
export default function TurboMatrix({ frameAt, frameCount, spec, fps, zoneMap, barcode }: Props) {
  const lanes = 2
  const stageRef = useRef<HTMLDivElement>(null)
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

  // VisualMatrix owns a play state for its normal standalone mode.  For the
  // compact lanes we retain continuous playback; this button is kept as an
  // explicit screen-level pause indication and rebuilding resumes the carousel.
  const pausedFps = playing ? fps : 0.001

  return (
    <div ref={stageRef} className="gd-turbo-stage">
      <div className="gd-turbo-grid" style={{ '--gd-lanes': lanes } as CSSProperties} aria-label={`LumaLink Turbo ${lanes} optical lanes`}>
        {Array.from({ length: lanes }, (_, lane) => (
          <VisualMatrix
            key={lane}
            compact
            frameAt={frameAt}
            frameCount={frameCount}
            spec={spec}
            fps={pausedFps}
            zoneMap={zoneMap}
            barcode={{ ...barcode, lanes: 2 }}
            frameOffset={lane}
            frameStride={lanes}
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
