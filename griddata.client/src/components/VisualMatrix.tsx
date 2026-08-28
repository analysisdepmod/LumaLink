import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Space, Tag, Button, Tooltip } from 'antd'
import {
  PauseOutlined, PlayCircleOutlined,
  FullscreenOutlined, FullscreenExitOutlined,
} from '@ant-design/icons'
import { encodeCellsRGB, encodeCellsRGBZoned, type EncodingSpec, type ZoneMap } from '../services/visualCodec'
import { encodeBarcodeRow, BARCODE_ROWS, type BarcodeData } from '../services/metaBarcode'
import { FRAME_RATIO, QUIET_RATIO, FINDER_SIZE_FRAC } from '../services/matrixVision'

interface Props {
  frameAt: (index: number) => Uint8Array
  frameCount: number
  spec: EncodingSpec
  fps: number
  zoneMap?: ZoneMap
  barcode?: BarcodeData
  /** A tile is rendered without its own controls; the parent owns the stage. */
  compact?: boolean
  /** Interleave this tile through one shared fountain stream. */
  frameOffset?: number
  frameStride?: number
  /** Display each logical frame for this many sender ticks (temporal combining). */
  holdTicks?: number
}

// Discovery must work even when the receiver opens midway through a transfer.
// Keep the proven high-contrast geometry permanently; CV acceleration happens in
// the receiver, not by making the optical finder too thin to acquire.
const PAYLOAD_FRAME_RATIO = FRAME_RATIO
const PAYLOAD_QUIET_RATIO = QUIET_RATIO
function isBootstrapFrame(frameNo: number, staticFrame: boolean): boolean {
  // A changing quiet zone makes mobile autofocus hunt. Keep animated transfers
  // in ONE optical geometry from the first frame; Bootstrap is now logical
  // (full locate + metadata confirmation), not a periodically moving border.
  void frameNo
  return staticFrame
}

// ── WebGL shaders ──
const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Flip Y: WebGL clip space has +Y up, but our pixel math (px = v_uv*canvasSize,
  // the orientation dot at a small px.y, texture row 0 = grid row 0) assumes +Y
  // DOWN like the Canvas2D fallback and the receiver. Without this flip the whole
  // matrix renders vertically MIRRORED — the camera then sees the grid reflected,
  // which the receiver's rotation-only orientation can't undo, so nothing decodes.
  v_uv = vec2(a_pos.x, -a_pos.y) * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_canvasSize;   // canvas pixel dimensions
uniform vec2 u_dataSize;     // data area pixel dimensions
uniform vec2 u_offset;       // top-left of data area in canvas pixels
uniform float u_quiet;       // quiet zone thickness
uniform float u_frame;       // frame thickness
uniform float u_dotSize;     // orientation dot size (0 ⇒ disabled, finders used)
uniform float u_dotOff;      // orientation dot offset from canvas edge
uniform vec2 u_f0;           // finder centres (TL, TR, BL, BR) in canvas pixels
uniform vec2 u_f1;
uniform vec2 u_f2;
uniform vec2 u_f3;
uniform float u_fSize;       // finder side in px (0 ⇒ disabled)
uniform float u_key;         // thin keyline outline thickness in px (0 ⇒ none)

// One QR-style concentric finder: 9 units across = 1 white separator + a 7-unit
// 1:1:3:1:1 (dark:light:dark:light:dark) pattern. Returns rgba, or a=-1 if the
// pixel is outside this finder. The receiver matches this exact ring layout.
vec4 finderAt(vec2 px, vec2 c, float S) {
  vec2 rel = abs(px - c);
  float m = max(rel.x, rel.y);
  if (m >= S * 0.5) return vec4(-1.0);
  float unit = S / 9.0;
  // TRUE QR 1:1:3:1:1 by direct distance thresholds. (The old floor(m/unit)<1.5
  // test made the dark centre FOUR units wide, not three, so the receiver's
  // 1:1:3:1:1 run detector measured the module size ~14% high → a systematic
  // registration offset that corrupted the single-row calibration anchors and
  // broke colour decode. The Canvas2D fallback was already correct; this matches it.)
  if (m < 1.5 * unit) return vec4(0.0, 0.0, 0.0, 1.0); // dark 3-unit centre
  if (m < 2.5 * unit) return vec4(1.0, 1.0, 1.0, 1.0); // white ring (1 unit)
  if (m < 3.5 * unit) return vec4(0.0, 0.0, 0.0, 1.0); // dark ring (1 unit)
  return vec4(1.0, 1.0, 1.0, 1.0);                     // white separator
}

void main() {
  vec2 px = v_uv * u_canvasSize;

  // Corner finder patterns (top-left, top-right, bottom-left) — painted on top of
  // the frame ring so the receiver can pin all four corners and the orientation.
  if (u_fSize > 0.0) {
    vec4 fc = finderAt(px, u_f0, u_fSize); if (fc.a >= 0.0) { gl_FragColor = fc; return; }
    fc = finderAt(px, u_f1, u_fSize); if (fc.a >= 0.0) { gl_FragColor = fc; return; }
    fc = finderAt(px, u_f2, u_fSize); if (fc.a >= 0.0) { gl_FragColor = fc; return; }
    fc = finderAt(px, u_f3, u_fSize); if (fc.a >= 0.0) { gl_FragColor = fc; return; }
  }

  // Orientation dot (top-left, inside the frame ring) — only when finders are off.
  if (u_dotSize > 0.0 &&
      px.x >= u_dotOff && px.x < u_dotOff + u_dotSize &&
      px.y >= u_dotOff && px.y < u_dotOff + u_dotSize) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }

  // Data cell — sample the texture with nearest-neighbor.
  if (px.x >= u_offset.x && px.x < u_offset.x + u_dataSize.x &&
      px.y >= u_offset.y && px.y < u_offset.y + u_dataSize.y) {
    vec2 cellUV = (px - u_offset) / u_dataSize;
    gl_FragColor = texture2D(u_tex, cellUV);
    return;
  }

  // Outside the data grid: the solid black frame ring (between the quiet zone and
  // the data), then the white quiet zone. The frame is the reliable, cheap locator
  // the receiver flood-fills for on real cameras; the corner finders sit on top of
  // it (painted above) and pin the precise corners. (u_key retained for the shader
  // signature but unused now.)
  // u_offset is authoritative. It lets Bootstrap centre a rectangular grid
  // inside the fixed Payload canvas without assuming equal horizontal/vertical
  // quiet-zone thicknesses.
  vec2 frameStart = u_offset - vec2(u_frame);
  vec2 frameEnd = u_offset + u_dataSize + vec2(u_frame);
  if (px.x >= frameStart.x && px.x < frameEnd.x &&
      px.y >= frameStart.y && px.y < frameEnd.y) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); // black frame
    return;
  }
  gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); // white quiet zone
}`

interface GlState {
  gl: WebGLRenderingContext
  prog: WebGLProgram
  tex: WebGLTexture
  locs: {
    canvasSize: WebGLUniformLocation
    dataSize: WebGLUniformLocation
    offset: WebGLUniformLocation
    quiet: WebGLUniformLocation
    frame: WebGLUniformLocation
    dotSize: WebGLUniformLocation
    dotOff: WebGLUniformLocation
    f0: WebGLUniformLocation
    f1: WebGLUniformLocation
    f2: WebGLUniformLocation
    f3: WebGLUniformLocation
    fSize: WebGLUniformLocation
    key: WebGLUniformLocation
  }
}

function initGL(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true })
  if (!gl) return null

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  gl.useProgram(prog)

  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  return {
    gl, prog, tex,
    locs: {
      canvasSize: gl.getUniformLocation(prog, 'u_canvasSize')!,
      dataSize: gl.getUniformLocation(prog, 'u_dataSize')!,
      offset: gl.getUniformLocation(prog, 'u_offset')!,
      quiet: gl.getUniformLocation(prog, 'u_quiet')!,
      frame: gl.getUniformLocation(prog, 'u_frame')!,
      dotSize: gl.getUniformLocation(prog, 'u_dotSize')!,
      dotOff: gl.getUniformLocation(prog, 'u_dotOff')!,
      f0: gl.getUniformLocation(prog, 'u_f0')!,
      f1: gl.getUniformLocation(prog, 'u_f1')!,
      f2: gl.getUniformLocation(prog, 'u_f2')!,
      f3: gl.getUniformLocation(prog, 'u_f3')!,
      fSize: gl.getUniformLocation(prog, 'u_fSize')!,
      key: gl.getUniformLocation(prog, 'u_key')!,
    },
  }
}

export default function VisualMatrix({ frameAt, frameCount, spec, fps, zoneMap, barcode, compact = false, frameOffset = 0, frameStride = 1, holdTicks = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const glRef = useRef<GlState | null>(null)
  const fallback2dRef = useRef(false)
  const [isPlaying, setIsPlaying] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const idxRef = useRef(0)

  const { gridW, gridH } = spec
  const cellSize = Math.max(6, Math.floor(1024 / Math.max(gridW, gridH)))
  const dataW = gridW * cellSize
  const dataH = gridH * cellSize
  const dataMax = Math.max(dataW, dataH)
  const payloadFrame = Math.max(2, Math.round(dataMax * PAYLOAD_FRAME_RATIO))
  const payloadQuiet = Math.max(2, Math.round(dataMax * PAYLOAD_QUIET_RATIO))
  const payloadOff = payloadQuiet + payloadFrame
  const bootstrapScale = (dataMax + 2 * dataMax * (PAYLOAD_FRAME_RATIO + PAYLOAD_QUIET_RATIO)) /
    (dataMax + 2 * dataMax * (FRAME_RATIO + QUIET_RATIO))
  // One fixed, high-contrast geometry for every animated frame. This prevents
  // autofocus hunting and lets a late-starting receiver run the robust locator.
  const canvasW = dataW + 2 * payloadOff
  const canvasH = dataH + 2 * payloadOff
  // QR-style corner finders: enabled only when the frame ring is thick enough to
  // hold a legible pattern (≥16 px). Centres sit at the ring-corner centres (half
  // a frame thickness in from each outer corner); the receiver predicts the same.
  // Thin keyline outline at the finder-band outer edge (x=quiet). A flood-fill
  // safety net for the legacy detector; ~2% of the tile (vs the old 7% solid frame),
  // thick enough to survive the receiver's coarse downsample. Sits where the old
  // frame's OUTER edge was, so the flood-fill → finder-refine path is unchanged.

  // Reusable RGBA buffer for texture upload (avoids per-frame allocation)
  const texBuf = useMemo(() => new Uint8Array(gridW * gridH * 4), [gridW, gridH])

  // Canvas2D fallback objects
  const cellCanvas = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = gridW; c.height = gridH
    return c
  }, [gridW, gridH])

  // Initialize GL on mount / when canvas changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gs = initGL(canvas)
    if (gs) {
      glRef.current = gs
      fallback2dRef.current = false
    } else {
      glRef.current = null
      fallback2dRef.current = true
    }
    return () => { glRef.current = null }
  }, [canvasW, canvasH])

  const drawFrameNo = useCallback((idx: number) => {
    const canvas = canvasRef.current
    if (!canvas || !frameCount) return
    // Turbo tiles do not create a second transfer.  They take disjoint frames
    // from the same fountain carousel, so every frame recovered by either tile
    // feeds the one decoder on the receiver.
    const logicalIndex = Math.floor(idx / Math.max(1, holdTicks))
    const frameNo = (logicalIndex * frameStride + frameOffset) % frameCount
    const opticalFrame = frameAt(frameNo)
    const rgb = zoneMap ? encodeCellsRGBZoned(opticalFrame, zoneMap) : encodeCellsRGB(opticalFrame, spec)
    const bootstrap = isBootstrapFrame(frameNo, frameCount <= 1)
    const dataScale = bootstrap ? bootstrapScale : 1
    const drawDataW = Math.round(dataW * dataScale)
    const drawDataH = Math.round(dataH * dataScale)
    const drawDataMax = Math.max(drawDataW, drawDataH)
    const frame = Math.max(2, Math.round(drawDataMax * (bootstrap ? FRAME_RATIO : PAYLOAD_FRAME_RATIO)))
    const quiet = Math.max(2, Math.round(drawDataMax * (bootstrap ? QUIET_RATIO : PAYLOAD_QUIET_RATIO)))
    const offX = Math.round((canvasW - drawDataW) / 2)
    const offY = Math.round((canvasH - drawDataH) / 2)
    const finderSize = frame >= 12 ? Math.round(frame * FINDER_SIZE_FRAC) : 0
    const outerX = offX - frame
    const outerY = offY - frame
    const finderCtrX = outerX + frame / 2
    const finderCtrY = outerY + frame / 2
    const keyline = Math.max(2, Math.round(drawDataMax * 0.014))
    // Finder centres (TL, TR, BL) in canvas px — built here from primitives so the
    // render-stable useCallback deps stay simple.
    const finders: [number, number][] = [
      [finderCtrX, finderCtrY],                 // top-left
      [canvasW - finderCtrX, finderCtrY],       // top-right
      [finderCtrX, canvasH - finderCtrY],       // bottom-left
      [canvasW - finderCtrX, canvasH - finderCtrY], // bottom-right
    ]
    // The barcode occupies rows reserved by visualCodec, outside the LDPC payload.
    // Keeping it static in every frame makes auto-detection stable on mobile cameras.
    if (barcode) {
      const br = encodeBarcodeRow(barcode, gridW)
      // Paint the same strip into all BARCODE_ROWS top rows so the receiver can
      // average them for a clean read (and it reads as a real, visible barcode).
      for (let r = 0; r < BARCODE_ROWS; r++) rgb.set(br, r * gridW * 3)
    }
    const n = gridW * gridH

    const gs = glRef.current
    if (gs && !fallback2dRef.current) {
      // ── WebGL path: upload RGB as texture, GPU does the rest ──
      const { gl, locs } = gs
      for (let i = 0; i < n; i++) {
        texBuf[i * 4] = rgb[i * 3]
        texBuf[i * 4 + 1] = rgb[i * 3 + 1]
        texBuf[i * 4 + 2] = rgb[i * 3 + 2]
        texBuf[i * 4 + 3] = 255
      }
      gl.viewport(0, 0, canvasW, canvasH)
      gl.bindTexture(gl.TEXTURE_2D, gs.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridW, gridH, 0, gl.RGBA, gl.UNSIGNED_BYTE, texBuf)
      gl.uniform2f(locs.canvasSize, canvasW, canvasH)
      gl.uniform2f(locs.dataSize, drawDataW, drawDataH)
      gl.uniform2f(locs.offset, offX, offY)
      gl.uniform1f(locs.quiet, quiet)
      gl.uniform1f(locs.frame, frame)
      // Finders replace the single orientation dot when they're enabled.
      gl.uniform1f(locs.dotSize, finderSize > 0 ? 0 : Math.max(3, Math.round(frame * 0.55)))
      gl.uniform1f(locs.dotOff, outerX + Math.round(frame * 0.22))
      gl.uniform2f(locs.f0, finders[0][0], finders[0][1])
      gl.uniform2f(locs.f1, finders[1][0], finders[1][1])
      gl.uniform2f(locs.f2, finders[2][0], finders[2][1])
      gl.uniform2f(locs.f3, finders[3][0], finders[3][1])
      gl.uniform1f(locs.fSize, finderSize)
      gl.uniform1f(locs.key, keyline)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return
    }

    // ── Canvas2D fallback ──
    const ctx = canvas.getContext('2d')
    const cctx = cellCanvas.getContext('2d')
    if (!ctx || !cctx) return
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvasW, canvasH)
    // Solid black frame ring (matches the WebGL shader branch) — the receiver's cheap
    // flood-fill locator; finders are painted on top of it below.
    ctx.fillStyle = '#000000'; ctx.fillRect(outerX, outerY, drawDataW + 2 * frame, drawDataH + 2 * frame)
    if (finderSize > 0) {
      // Concentric squares: white separator, dark ring, white ring, dark centre —
      // the same 1:1:3:1:1 layout the shader paints and the receiver matches.
      const u = finderSize / 9
      for (const [fx, fy] of finders) {
        const sq = (half: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(fx - half, fy - half, half * 2, half * 2) }
        sq(4.5 * u, '#ffffff') // separator
        sq(3.5 * u, '#000000') // dark outer ring
        sq(2.5 * u, '#ffffff') // white ring
        sq(1.5 * u, '#000000') // dark 3x3 centre
      }
    } else {
      const dot = Math.max(3, Math.round(frame * 0.55))
      const dotOff = outerX + Math.round(frame * 0.22)
      ctx.fillStyle = '#ffffff'; ctx.fillRect(dotOff, dotOff, dot, dot)
    }
    const img = cctx.createImageData(gridW, gridH)
    for (let i = 0; i < n; i++) {
      img.data[i * 4] = rgb[i * 3]
      img.data[i * 4 + 1] = rgb[i * 3 + 1]
      img.data[i * 4 + 2] = rgb[i * 3 + 2]
      img.data[i * 4 + 3] = 255
    }
    cctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(cellCanvas, 0, 0, gridW, gridH, offX, offY, drawDataW, drawDataH)
  }, [frameAt, frameCount, spec, gridW, gridH, dataW, dataH, canvasW, canvasH, bootstrapScale, cellCanvas, texBuf, zoneMap, barcode, holdTicks])

  const isStatic = frameCount <= 1

  useEffect(() => {
    idxRef.current = 0
    drawFrameNo(0)
  }, [frameCount, drawFrameNo])

  useEffect(() => {
    if (isStatic || !isPlaying || !frameCount) return
    let raf = 0
    let last = performance.now()
    const interval = 1000 / fps
    const loop = (now: number) => {
      if (now - last >= interval) {
        last = now
        idxRef.current = (idxRef.current + 1) % (frameCount * Math.max(1, holdTicks))
        drawFrameNo(idxRef.current)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isStatic, isPlaying, fps, frameCount, drawFrameNo, holdTicks])


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
    } catch { /* fullscreen can be blocked */ }
  }, [])

  useEffect(() => {
    let lock: { release?: () => Promise<void> } | null = null
    const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release?: () => Promise<void> }> } }
    const acquire = () => nav.wakeLock?.request('screen').then(l => { lock = l }).catch(() => {})
    acquire()
    const onVis = () => { if (document.visibilityState === 'visible') acquire() }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); lock?.release?.().catch(() => {}) }
  }, [])

  if (compact) {
    return (
      <canvas
        ref={canvasRef}
        className="gd-matrix gd-turbo-matrix"
        width={canvasW}
        height={canvasH}
        onClick={() => !isStatic && setIsPlaying(p => !p)}
        style={{ aspectRatio: `${canvasW} / ${canvasH}`, cursor: isStatic ? 'default' : 'pointer' }}
      />
    )
  }

  return (
    <div>
      <div ref={stageRef} className="gd-stage gd-fullbleed">
        <canvas
          ref={canvasRef}
          className="gd-matrix"
          width={canvasW}
          height={canvasH}
          onClick={() => !isStatic && setIsPlaying(p => !p)}
          style={{ aspectRatio: `${canvasW} / ${canvasH}`, cursor: isStatic ? 'default' : 'pointer' }}
        />

        <Space size={8} wrap style={{ marginTop: 12, justifyContent: 'center' }}>
          <Tag color="cyan">{spec.enc === 'bw' ? 'لونان' : `${spec.enc.replace('color', '')} ألوان`} · {gridW}×{gridH}</Tag>
          {!isStatic && <Tag color="green">{fps} fps</Tag>}
          {!isStatic && (
            <Button
              size="small"
              icon={isPlaying ? <PauseOutlined /> : <PlayCircleOutlined />}
              onClick={() => setIsPlaying(p => !p)}
            >
              {isPlaying ? 'إيقاف' : 'تشغيل'}
            </Button>
          )}
          <Tooltip title={isFullscreen ? 'خروج من ملء الشاشة' : 'ملء الشاشة — أكبر حجم ممكن للعرض'}>
            <Button
              size="small"
              type={isFullscreen ? 'default' : 'primary'}
              ghost={!isFullscreen}
              icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? 'خروج' : 'ملء الشاشة'}
            </Button>
          </Tooltip>
        </Space>
      </div>

    </div>
  )
}
