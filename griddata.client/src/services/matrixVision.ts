// Matrix registration for camera reading.
//
// The transmitted matrix is drawn with a WHITE quiet zone and a solid BLACK
// frame around the data grid (see layout constants below). The receiver finds
// that black frame in the camera image, so it knows exactly where the grid is
// and can sample each cell at the right pixel — instead of blindly assuming the
// matrix fills the center of the video (which never happens freehand and was
// why nothing decoded). This is the minimal "finder pattern": one border, the
// rest of the area stays data.

import type { CellReadings } from './visualCodec'

export const FRAME_RATIO = 0.07 // black frame thickness ÷ data-grid size
export const QUIET_RATIO = 0.07 // white quiet zone ÷ data-grid size
// Fraction to inset the detected outer-dark rectangle (data+frame) on each side to
// reach the data grid itself: frame / (data + 2·frame).
export const INSET_FRAC = FRAME_RATIO / (1 + 2 * FRAME_RATIO)

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Locate the data grid in the camera frame and sample every cell.
 * Returns null when the frame can't be found (nothing aligned yet).
 */
export function sampleWithRegistration(
  ctx: CanvasRenderingContext2D,
  w: number, h: number, gridW: number, gridH: number,
): CellReadings | null {
  return sampleWithRegistrationPixels(ctx.getImageData(0, 0, w, h).data, w, h, gridW, gridH)
}

/** A perspective map from the unit square to the located data grid, or null. */
export type GridMap = (u: number, v: number) => Pt

/** Four corners of a located quad, in image pixels (top-left origin). */
export interface Corners { tl: Pt; tr: Pt; br: Pt; bl: Pt }

/**
 * Full result of locating the matrix: the data-grid sampling map plus the two
 * quads that describe where the tile sits in the frame — `outer` is the black
 * finder frame's outer edge (what the on-screen tracking brackets hug), `inner`
 * is the data grid itself. Corners are in the input image's pixel coordinates.
 */
export interface Located {
  map: GridMap; outer: Corners; inner: Corners
  /** True when the corners were pinned by the QR finder patterns (accurate), false
   *  when only the geometric fallback ran. */
  refined: boolean
  /** Seed for next frame's tracked fast path — present only on finder-refined
   *  fits (the only ones precise enough to track from). The decode worker feeds it
   *  back into {@link locateMatrixTracked}, which re-pins the finders in small
   *  windows around these centres and skips the full Otsu + flood-fill scan. */
  track?: TrackState
}

/** Everything {@link locateMatrixTracked} needs to re-find the matrix next frame
 *  without a full-image search: the four finder centres in image pixels, the QR
 *  module size (px), and the luminance threshold used to binarise the finders. */
export interface TrackState { centers: [Pt, Pt, Pt, Pt]; ms: number; t: number }

/**
 * Locate the data grid in the camera frame and return the perspective map — the
 * GRID-INDEPENDENT half of registration. The receiver can then sample this one
 * map at several candidate grid sizes (auto-detect) without re-running the
 * expensive detection per grid.
 */
export function locateMatrixPixels(px: Uint8ClampedArray, w: number, h: number): GridMap | null {
  return locateMatrix(px, w, h)?.map ?? null
}


/**
 * Full (non-tracked) matrix location. Runs the robust KEYLINE flood-fill first —
 * the thin dark outline the sender draws at the tile's outer edge is a clean,
 * unambiguous rectangle that a cheap 160px downsample finds reliably at every grid
 * density, and the finders then pin the precise map. Only if no keyline is found
 * (an old frameless capture, or the outline was lost) does it fall back to the
 * finder-first scan, which is heavier and can be fooled by dense data cells. Both
 * end in the same finder-refined, centre-based map.
 */
export function locateMatrix(px: Uint8ClampedArray, w: number, h: number): Located | null {
  return locateByKeyline(px, w, h)
}

/**
 * Coarse location via the tile's outer black frame: flood-fill the largest dark
 * rectangle, take its corners, and hand off to the finder refinement + map builder.
 * Returns null when no suitable frame is found.
 */
function locateByKeyline(px: Uint8ClampedArray, w: number, h: number): Located | null {
  // Downsample size for the (pure-JS, per-frame) coarse detection. Raised 160→224:
  // when the matrix is captured with vertical perspective (held at an angle), the
  // far-edge WHITE quiet zone foreshortens to a hair; at 160 it collapsed below one
  // downsampled pixel, so the flood-fill bridged the tile into the dark background
  // above it and the coarse quad grew past the matrix — which mis-predicted the top
  // finder centres (field: F2[0,0,X,X], top finders never found, quad too tall). More
  // downsample rows keep that thin quiet zone resolved so the tile stays separated.
  // Corners are still refined against the FULL-res image, so precision is unchanged.
  const S = 224
  const sw = w >= h ? S : Math.max(1, Math.round(S * w / h))
  const sh = h > w ? S : Math.max(1, Math.round(S * h / w))
  const gray = new Float32Array(sw * sh)
  const sx = w / sw, sy = h / sh
  for (let y = 0; y < sh; y++) {
    const iy = Math.min(h - 1, (y * sy) | 0)
    for (let x = 0; x < sw; x++) {
      const ix = Math.min(w - 1, (x * sx) | 0)
      const p = (iy * w + ix) * 4
      gray[y * sw + x] = px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114
    }
  }
  const t = otsu(gray)
  const dark = new Uint8Array(sw * sh)
  for (let i = 0; i < gray.length; i++) dark[i] = gray[i] < t ? 1 : 0
  const box = largestRectComponent(dark, sw, sh)
  if (!box) return null
  const rq = frameCornersFast(px, w, h, dark, sw, sh, sx, sy, box, t)
  if (!rq) return null
  // Reject skewed/torn captures: the matrix is square, so a good quad has four
  // near-equal sides. A capture taken mid screen-refresh (tear) or during fast
  // motion yields a lopsided quad — drop it rather than feed a warped read to the
  // decoder (it would just fail CRC and waste a soft-combine slot anyway).
  if (!quadIsSquareEnough(rq)) return null

  const edge = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  const rW = (edge(rq.tl, rq.tr) + edge(rq.bl, rq.br)) / 2
  const rH = (edge(rq.tl, rq.bl) + edge(rq.tr, rq.br)) / 2
  const framePx = INSET_FRAC * Math.max(rW, rH)

  // Precise registration via the three QR-style finder patterns the sender paints
  // in the frame-ring corners (top-left, top-right, bottom-left). Matching those
  // patterns pins each corner to sub-pixel accuracy AND fixes orientation (the
  // corner WITHOUT a finder is bottom-right). Falls back to the geometric
  // brightness-dot orientation when the finders aren't seen (old sender, or the
  // markers are too small/blurred) — so this can only help, never regress.
  const ref = refineWithFinders(px, w, h, rq, framePx, rW, rH, t)
  // `quad` = black-frame outer, drives registration/inset. `displayQuad` = the QR
  // markers' outer edges, drawn as the green brackets so they hug the three QR
  // patterns exactly. Without finders both fall back to the geometric quad.
  let quad: Quad, displayQuad: Quad
  if (ref) { quad = ref.frame; displayQuad = ref.markers }
  else { quad = orientQuad(px, w, h, rq); displayQuad = quad }

  return buildLocated(quad, displayQuad, ref ? { centers: ref.centers, ms: ref.ms, t } : null)
}

/**
 * Fast-path registration for a matrix already located last frame. Skips the whole
 * coarse detector (grayscale downsample + Otsu + flood-fill + corner search) and
 * instead re-pins the four QR finders in small windows around their PREVIOUS
 * centres, rebuilding the map from those. Both devices sit propped, so the tile
 * barely moves frame-to-frame and the finders are almost always right where they
 * were — this is where the scan-rate comes from, and it keeps the tracking
 * brackets steady because a fit lands on (almost) every frame. Returns null when
 * the finders drift out of their windows (fast motion / re-aim); the caller then
 * falls back to the full {@link locateMatrix}.
 */
export function locateMatrixTracked(px: Uint8ClampedArray, w: number, h: number, prev: TrackState): Located | null {
  const framePx = 10 * prev.ms // framePx = 2·(5·ms); see refineFromPredicted geometry
  // The tracked path is allowed to skip the coarse keyline detector only when
  // every finder is freshly measured. Reconstructing one or two missing corners
  // is useful during full acquisition, but unsafe for tracking: a reconstructed
  // point can carry a small error forward until the sampling map drifts by a cell.
  const ref = refineFromPredicted(px, w, h, prev.centers, framePx, prev.t, 4)
  if (!ref) return null
  if (!quadIsSquareEnough(ref.frame)) return null
  return buildLocated(ref.frame, ref.markers, { centers: ref.centers, ms: ref.ms, t: prev.t })
}

/**
 * Reuse the last finder-pinned map for a very short acquisition gap. The black
 * frame and finders are static on the sender, while mobile auto-focus can make
 * one video exposure temporarily fail both detectors. This function performs no
 * image claim; callers must bound its use and continue trying fresh location.
 */
export function locateMatrixHeld(prev: TrackState): Located {
  const [tl, tr, br, bl] = prev.centers
  const quad: Quad = { tl, tr, br, bl }
  return buildLocated(quad, quad, prev)
}

/**
 * Turn a located quad + marker quad into the grid sampling map.
 *
 * When finder centres are known (`track`), we build the map DIRECTLY from the four
 * measured finder centres and the measured centre→data-edge gap (5·ms): the
 * homography over the centres, with the data grid placed at the fractional inset
 * (5·ms / centre-span) on each axis. This is exact — it uses only measured
 * quantities. The old path stepped the centres OUT to a frame quad and then inset
 * again by a fixed ratio; those two approximations compounded into a ~0.8% scale
 * error that drifted a dense 128²/256² grid by ~1 cell at the far edge (12% of
 * cells then straddled a neighbour and colour decode collapsed).
 *
 * The legacy branch (no finders — old black-frame senders via the flood-fill
 * fallback) keeps the constant-thickness ratio inset.
 */
function buildLocated(quad: Quad, displayQuad: Quad, track: TrackState | null): Located {
  const edge = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  let map: GridMap
  let inTL: Pt, inTR: Pt, inBR: Pt, inBL: Pt
  if (track) {
    const [tl, tr, br, bl] = track.centers
    const Hf = homographyUnitSquareToQuad(tl, tr, br, bl)
    const spanH = (edge(tl, tr) + edge(bl, br)) / 2
    const spanV = (edge(tl, bl) + edge(tr, br)) / 2
    // Finder centre sits 5·ms outside the data edge on each axis; as a fraction of
    // the centre-to-centre span that is the data grid's inset within the centres.
    const exf = Math.min(0.45, 5 * track.ms / Math.max(1, spanH))
    const eyf = Math.min(0.45, 5 * track.ms / Math.max(1, spanV))
    const sx2 = 1 - 2 * exf, sy2 = 1 - 2 * eyf
    map = (u, v) => Hf(exf + u * sx2, eyf + v * sy2)
    inTL = map(0, 0); inTR = map(1, 0); inBR = map(1, 1); inBL = map(0, 1)
  } else {
    // Legacy: inset the outer quad (data + constant-thickness band) by the same
    // pixel amount on all four sides (a fraction of the LONG side, applied to both).
    const outer = homographyUnitSquareToQuad(quad.tl, quad.tr, quad.br, quad.bl)
    const outerW = (edge(quad.tl, quad.tr) + edge(quad.bl, quad.br)) / 2
    const outerH = (edge(quad.tl, quad.bl) + edge(quad.tr, quad.br)) / 2
    const fpx = INSET_FRAC * Math.max(outerW, outerH)
    const kx = Math.min(0.45, fpx / Math.max(1, outerW))
    const ky = Math.min(0.45, fpx / Math.max(1, outerH))
    inTL = outer(kx, ky); inTR = outer(1 - kx, ky); inBR = outer(1 - kx, 1 - ky); inBL = outer(kx, 1 - ky)
    map = homographyUnitSquareToQuad(inTL, inTR, inBR, inBL)
  }
  // `displayQuad` = the QR-marker quad, so the green brackets sit right on the
  // markers. Order its corners by SCREEN position (not marker orientation), so the
  // bracket labels never permute frame-to-frame.
  return {
    map,
    outer: canonicalCorners(displayQuad),
    inner: { tl: inTL, tr: inTR, br: inBR, bl: inBL },
    refined: !!track,
    track: track ?? undefined,
  }
}

/** Relabel four points as tl/tr/br/bl by image position (x±y extremes), giving a
 *  rotation-stable order for the on-screen frame regardless of tile orientation. */
function canonicalCorners(q: Quad): Corners {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0]
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p
    if (p.x + p.y > br.x + br.y) br = p
    if (p.x - p.y > tr.x - tr.y) tr = p
    if (p.x - p.y < bl.x - bl.y) bl = p
  }
  return { tl, tr, br, bl }
}

// ── QR finder-pattern refinement ──────────────────────────────────────────────
// The sender paints a 3-corner set of concentric-square finders (1:1:3:1:1 like a
// QR code) inside the black frame ring. `FINDER_SIZE_FRAC` is the finder's side
// as a fraction of the frame thickness; its centre sits at the ring-corner centre
// (half a frame thickness in from the outer corner on each axis). Both constants
// are shared with the sender (VisualMatrix) so the two agree on the geometry.
export const FINDER_SIZE_FRAC = 0.9

/** Nearest-neighbour luminance at a fractional pixel, or -1 out of bounds. */
function grayAt(px: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  const xi = x | 0, yi = y | 0
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1
  const p = (yi * w + xi) * 4
  return px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114
}

// Classic QR finder-pattern detection: a scanline that runs across a finder sees
// the run-length ratio 1:1:3:1:1 (dark:light:dark:light:dark) regardless of scale
// or moderate perspective. We run that state machine along the rows AND columns of
// a small window around each predicted corner, keep only matches whose module size
// fits the expected marker, and average the hit centres. This is the same
// detection principle battle-tested optical readers use — implemented here from
// scratch (no third-party engine), so it is far more robust than a fixed template.

/** True-ratio check of five run lengths against 1:1:3:1:1; returns the module
 *  size (total/7) when it matches within tolerance, else 0. */
function finderRatio(c0: number, c1: number, c2: number, c3: number, c4: number): number {
  const total = c0 + c1 + c2 + c3 + c4
  if (total < 7) return 0
  const ms = total / 7
  const v = ms * 0.6 // generous variance — camera blur smears the run edges
  if (Math.abs(ms - c0) < v && Math.abs(ms - c1) < v && Math.abs(3 * ms - c2) < 3 * v &&
      Math.abs(ms - c3) < v && Math.abs(ms - c4) < v) return ms
  return 0
}

/**
 * Scan one line (via `dark(i)` over i∈[0,len)) with the shifting 1:1:3:1:1 state
 * machine; call `onHit(center, ms)` for each finder crossing whose module size is
 * in [msMin,msMax]. `center` is the sub-pixel centre of the middle (3×) run.
 */
function scanFinderLine(dark: (i: number) => boolean, len: number, msMin: number, msMax: number, onHit: (center: number, ms: number) => void): void {
  const sc = [0, 0, 0, 0, 0]
  let cur = 0, started = false
  for (let i = 0; i < len; i++) {
    if (dark(i)) {
      if ((cur & 1) === 1) cur++       // was in a light run → start a dark run
      sc[cur]++; started = true
    } else {
      if (!started) continue           // ignore the leading light margin
      if ((cur & 1) === 0) {           // was in a dark run → a light pixel closes it
        if (cur === 4) {
          const ms = finderRatio(sc[0], sc[1], sc[2], sc[3], sc[4])
          if (ms > 0 && ms >= msMin && ms <= msMax) onHit(i - sc[4] - sc[3] - sc[2] / 2, ms)
          sc[0] = sc[2]; sc[1] = sc[3]; sc[2] = sc[4]; sc[3] = 1; sc[4] = 0; cur = 3
        } else { cur++; sc[cur]++ }
      } else sc[cur]++                  // continuing a light run
    }
  }
}

/**
 * Locate a finder pattern near (cx,cy). Scans the window's rows and columns for
 * the 1:1:3:1:1 signature and averages every hit centre → a sub-pixel, blur- and
 * perspective-tolerant centre. Returns null (with the hit count) if too few lines
 * agree, i.e. there is no finder here (e.g. the empty bottom-right corner).
 */
function findFinderNear(px: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, framePx: number, t: number): { pt: Pt; count: number; ms: number; ok: boolean } {
  const S = framePx * FINDER_SIZE_FRAC
  const expMs = S / 9
  // Wide search window: the predicted centre comes from the coarse quad, whose error
  // grows with the matrix size, so at close range the finder can drift far from the
  // prediction. A generous window keeps it inside.
  const half = Math.round(S * 1.35) + 3
  const x0 = Math.max(0, Math.round(cx) - half), x1 = Math.min(w - 1, Math.round(cx) + half)
  const y0 = Math.max(0, Math.round(cy) - half), y1 = Math.min(h - 1, Math.round(cy) + half)
  // SCALE-INVARIANT detection. When the matrix fills the camera frame the finder is
  // captured at high resolution (framePx large): its fine 1:1:3:1:1 rings pick up the
  // display's per-pixel / sub-pixel structure and moiré, which breaks the run pattern
  // so NO scan line matches — the field failure was F0[0,0,0,0] at fpx≈57 while fpx≈29
  // gave F4[16,14,17,16]. So we DOWNSAMPLE the window (box-average, ds chosen so the
  // module lands near ~3 px, the scale where detection is robust) and scan THAT: the
  // averaging erases the sub-pixel noise and the runs become clean at any capture
  // size. ds=1 at moderate distance → the already-working path is untouched.
  const ds = Math.max(1, Math.round(expMs / 3))
  const dw = Math.max(1, Math.floor((x1 - x0 + 1) / ds)), dh = Math.max(1, Math.floor((y1 - y0 + 1) / ds))
  const buf = new Float32Array(dw * dh)
  for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
    let s = 0, c = 0
    for (let dy = 0; dy < ds; dy++) for (let dx = 0; dx < ds; dx++) {
      const xx = x0 + i * ds + dx, yy = y0 + j * ds + dy
      if (xx > x1 || yy > y1) continue
      s += grayAt(px, w, h, xx, yy); c++
    }
    buf[j * dw + i] = c ? s / c : 0
  }
  // LOCAL threshold on the downsampled window: the global otsu (dominated by the
  // bright colour field + white quiet zone) can sit above the captured white level
  // and make the finder read all-dark; its own min/max never does.
  let lo = 255, hi = 0
  for (let k = 0; k < buf.length; k++) { const v = buf[k]; if (v < lo) lo = v; if (v > hi) hi = v }
  const tLoc = (hi - lo) > 24 ? (lo + hi) * 0.5 : t
  const em = expMs / ds                    // expected module in the downsampled buffer
  const msMin = em * 0.3, msMax = em * 3.0
  let sx = 0, sy = 0, n = 0, sms = 0
  const darkRow = (j: number) => (i: number) => buf[j * dw + i] < tLoc
  const darkCol = (i: number) => (j: number) => buf[j * dw + i] < tLoc
  for (let j = 0; j < dh; j++) scanFinderLine(darkRow(j), dw, msMin, msMax, (c, ms) => { sx += x0 + c * ds; sy += y0 + j * ds; sms += ms * ds; n++ })
  for (let i = 0; i < dw; i++) scanFinderLine(darkCol(i), dh, msMin, msMax, (c, ms) => { sx += x0 + i * ds; sy += y0 + c * ds; sms += ms * ds; n++ })
  const minHits = Math.max(4, Math.round(em))
  // `ok` says whether the hit count clears minHits (a real finder here, not the
  // empty corner); `ms` (mapped back to full-res) drives the geometry.
  return { pt: n ? { x: sx / n, y: sy / n } : { x: cx, y: cy }, count: n, ms: n ? sms / n : 0, ok: n >= minHits }
}

/** What a finder-refined fit yields: the black-frame outer quad (`frame`, drives
 *  registration), the QR-marker-hugging quad (`markers`, the on-screen brackets),
 *  the four measured finder CENTRES (`centers`, the seed for next frame's tracked
 *  fit), and the average QR module size in px (`ms`). */
interface FinderFit { frame: Quad; markers: Quad; centers: [Pt, Pt, Pt, Pt]; ms: number }

/**
 * Refine four finder patterns from four PREDICTED centres. This is the shared
 * core of both registration paths: the full detector predicts the centres from
 * the geometric quad, the tracked fast path predicts them from the previous
 * frame's fit — either way we scan a small window at each predicted spot for the
 * 1:1:3:1:1 signature, pin the ones we find to sub-pixel accuracy, fill any we
 * miss from the prediction, then step the centres out to the marker/frame quads.
 * Full acquisition accepts two measured corners; strict tracking raises the
 * caller-provided minimum to four so no reconstructed corner can carry drift.
 */
function refineFromPredicted(px: Uint8ClampedArray, w: number, h: number, predicted: Pt[], framePx: number, t: number, minFound = 2): FinderFit | null {
  // Below ~8 px the marker rings are too small to resolve the 1:1:3:1:1 runs.
  if (framePx < 8) return null
  const res = predicted.map(c => findFinderNear(px, w, h, c.x, c.y, framePx, t))
  const nFound = res.filter(r => r.ok).length
  // Two measured finder centres are enough: they anchor the fit's position, scale
  // and rotation with sub-pixel accuracy and give the true module size, while the
  // missing corners are filled from the (perspective-correct) predicted centres.
  // That is far better than dropping to the geometric-quad fallback (ZERO measured
  // corners) just because one or two corners are washed out by screen glare — the
  // observed field case where fpx grew and detection fell from F4 to F2, stalling.
  if (nFound < minFound) return null
  const msVals = res.filter(r => r.ok).map(r => r.ms)
  const ms = msVals.reduce((a, b) => a + b, 0) / msVals.length
  // Reconstruct any MISSING finder corner from a SQUARE (similarity) fit through the
  // FOUND finder centres — translation + rotation + uniform scale — NOT from the
  // coarse quad. The coarse quad can be wildly wrong when the matrix fills the frame
  // (it once spanned the whole camera view); filling a 2-finder fit from it dragged
  // the whole quad huge (field: F2[0,0,13,13] with brackets covering the screen). The
  // real finders are exact, so the square through them recovers the true tile; found
  // corners keep their measured position, only missing ones come from the fit. The
  // predicted centres remain the last-resort seed if the fit is degenerate.
  const UV = [[0, 0], [1, 0], [1, 1], [0, 1]]
  let c: Pt[]
  if (nFound >= 4) c = res.map(r => r.pt)
  else if (nFound === 3) {
    // Three real corners fix an AFFINE frame exactly (parallelogram), so the fourth
    // is measured neighbours ± opposite — this preserves the capture's real aspect /
    // shear instead of forcing a square, which is what made the reconstructed quad
    // too TALL under vertical perspective.
    const m = res.findIndex(r => !r.ok)
    c = res.map(r => r.pt) // the three found are exact; overwrite the missing one
    c[m] = {
      x: res[(m + 1) % 4].pt.x + res[(m + 3) % 4].pt.x - res[(m + 2) % 4].pt.x,
      y: res[(m + 1) % 4].pt.y + res[(m + 3) % 4].pt.y - res[(m + 2) % 4].pt.y,
    }
  } else {
    let mux = 0, muy = 0, mvx = 0, mvy = 0, N = 0
    for (let i = 0; i < 4; i++) if (res[i].ok) { mux += UV[i][0]; muy += UV[i][1]; mvx += res[i].pt.x; mvy += res[i].pt.y; N++ }
    mux /= N; muy /= N; mvx /= N; mvy /= N
    let a = 0, b = 0, d = 0
    for (let i = 0; i < 4; i++) if (res[i].ok) { const su = UV[i][0] - mux, sv = UV[i][1] - muy, tx = res[i].pt.x - mvx, ty = res[i].pt.y - mvy; a += su * tx + sv * ty; b += su * ty - sv * tx; d += su * su + sv * sv }
    if (d < 1e-6) c = res.map((r, i) => r.ok ? r.pt : predicted[i])
    else {
      const sc = a / d, ss = b / d
      const mapSim = (u: number, v: number): Pt => ({ x: sc * (u - mux) - ss * (v - muy) + mvx, y: ss * (u - mux) + sc * (v - muy) + mvy })
      c = res.map((r, i) => r.ok ? r.pt : mapSim(UV[i][0], UV[i][1]))
    }
  }
  // Order by SCREEN position so u/v (below) and the drawn frame are rotation-stable.
  const q0 = canonicalCorners({ tl: c[0], tr: c[1], br: c[2], bl: c[3] })
  const norm = (dx: number, dy: number) => { const L = Math.hypot(dx, dy) || 1; return { x: dx / L, y: dy / L } }
  const u = norm(q0.tr.x - q0.tl.x, q0.tr.y - q0.tl.y)   // along the top edge (→)
  const v = norm(q0.bl.x - q0.tl.x, q0.bl.y - q0.tl.y)   // along the left edge (↓)
  // Each finder centre is S/2 = 4.5·ms in from the tile edge on both axes; the
  // black-frame outer corner is framePx/2 = 5·ms out. Step every REAL centre out
  // by `s` along both edge directions. `markers` (4.5·ms) hugs the QR outer edges
  // for the green brackets; `frame` (5·ms) is the black-frame outer for registration.
  const build = (s: number): Quad => ({
    tl: { x: q0.tl.x - s * (u.x + v.x), y: q0.tl.y - s * (u.y + v.y) },
    tr: { x: q0.tr.x + s * (u.x - v.x), y: q0.tr.y + s * (u.y - v.y) },
    br: { x: q0.br.x + s * (u.x + v.x), y: q0.br.y + s * (u.y + v.y) },
    bl: { x: q0.bl.x + s * (-u.x + v.x), y: q0.bl.y + s * (-u.y + v.y) },
  })
  return { markers: build(4.5 * ms), frame: build(5 * ms), centers: [q0.tl, q0.tr, q0.br, q0.bl], ms }
}

/**
 * Full-detector finder refinement: predicts the four finder centres from the
 * geometric quad (half a frame thickness in from each outer corner), then hands
 * off to {@link refineFromPredicted}.
 */
function refineWithFinders(px: Uint8ClampedArray, w: number, h: number, rq: Quad, framePx: number, rW: number, rH: number, t: number): FinderFit | null {
  const outer = homographyUnitSquareToQuad(rq.tl, rq.tr, rq.br, rq.bl)
  const tX = (framePx / 2) / Math.max(1, rW), tY = (framePx / 2) / Math.max(1, rH)
  const uvCorners = [[tX, tY], [1 - tX, tY], [1 - tX, 1 - tY], [tX, 1 - tY]] // winding TL,TR,BR,BL
  const predicted = uvCorners.map(([u, v]) => outer(u, v))
  return refineFromPredicted(px, w, h, predicted, framePx, t)
}

/** Sample every cell of a `gridW`×`gridH` grid through a located map. */
export function sampleMapped(px: Uint8ClampedArray, w: number, h: number, map: GridMap, gridW: number, gridH: number, maxWindow = 2): CellReadings {
  return sampleHomography(px, w, h, map, gridW, gridH, maxWindow)
}

/**
 * Fast black/white sampler.  A binary display has identical R/G/B transmit
 * values, so carrying three sampled channels through the hot 128² path only
 * creates allocations and arithmetic.  The green sensor plane is the cleanest
 * Bayer-derived luminance estimate on phone cameras; a centred 3×3 window also
 * avoids blending a sharp black/white cell with its neighbours.  Reliability is
 * still measured and fed into the same soft decoder / temporal combiner.
 */
const EMPTY_BINARY_CHANNEL = new Float32Array(0)

// Per-worker sampling buffers. A worker handles one request at a time and every
// consumer completes synchronously before the next sample, so retaining one exact-
// sized set removes five typed-array allocations per camera exposure without any
// cross-frame aliasing. Exact sizes matter because downstream filters use .length.
const COLOR_SAMPLE_SCRATCH = new Map<number, CellReadings>()
function colorSamplingScratch(n: number): CellReadings {
  let rd = COLOR_SAMPLE_SCRATCH.get(n)
  if (!rd) {
    rd = {
      r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
      lum: new Float32Array(n), rel: new Float32Array(n),
    }
    COLOR_SAMPLE_SCRATCH.set(n, rd)
  }
  return rd
}

export function sampleMappedBinary(px: Uint8ClampedArray, w: number, h: number, map: GridMap, gridW: number, gridH: number): CellReadings {
  const n = gridW * gridH
  const lum = new Float32Array(n), rel = new Float32Array(n)
  const c00 = map(0, 0), c10 = map(1, 0), c01 = map(0, 1)
  const cellPxW = Math.hypot(c10.x - c00.x, c10.y - c00.y) / gridW
  const cellPxH = Math.hypot(c01.x - c00.x, c01.y - c00.y) / gridH
  // Never expand beyond 3×3: at BW Boost's ≥6 px cells a larger window gives
  // little noise benefit but can cross a module edge under small homography drift.
  const win = Math.min(1, Math.max(0, Math.floor(Math.min(cellPxW, cellPxH) / 4)))
  const relScale = 1 / (28 * 28)
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const c = map((gx + 0.5) / gridW, (gy + 0.5) / gridH)
      const cx = c.x | 0, cy = c.y | 0
      let sum = 0, sumSq = 0, count = 0
      for (let dy = -win; dy <= win; dy++) {
        const yy = cy + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -win; dx <= win; dx++) {
          const xx = cx + dx
          if (xx < 0 || xx >= w) continue
          // Green is closest to luma for a Bayer camera and costs one read.
          const value = px[(yy * w + xx) * 4 + 1]
          sum += value; sumSq += value * value; count++
        }
      }
      const i = gy * gridW + gx
      if (count === 0) continue
      const mean = sum / count
      lum[i] = mean
      rel[i] = 1 / (1 + Math.max(0, sumSq / count - mean * mean) * relScale)
    }
  }
  // BW soft demodulation consumes lum/rel only; sharing empty RGB arrays avoids
  // allocating three unused 128² buffers on every camera exposure.
  return { r: EMPTY_BINARY_CHANNEL, g: EMPTY_BINARY_CHANNEL, b: EMPTY_BINARY_CHANNEL, lum, rel }
}

/**
 * Cheap luminance-only sampling of a SINGLE grid row (default row 0). Used by the
 * barcode-first detector to probe many candidate grid widths per frame without
 * paying for a full-grid sample each time — the metadata barcode lives in row 0,
 * so this is all we need to identify the sender's spec.
 */
export function sampleRowLum(
  px: Uint8ClampedArray, w: number, h: number, map: GridMap,
  gridW: number, gridH: number, row = 0,
): Float32Array {
  const out = new Float32Array(gridW)
  const v = (row + 0.5) / gridH
  // Window ≈ ¼ cell, so each read is a small average (matches sampleHomography) —
  // a single-pixel read is far too noise-sensitive for the barcode's hard bits.
  const c0 = map(0, v), c1 = map(1, v)
  const cellPx = Math.hypot(c1.x - c0.x, c1.y - c0.y) / gridW
  const win = Math.max(0, Math.floor(cellPx / 4))
  for (let gx = 0; gx < gridW; gx++) {
    const c = map((gx + 0.5) / gridW, v)
    const cx = c.x | 0, cy = c.y | 0
    let s = 0, cnt = 0
    for (let dy = -win; dy <= win; dy++) {
      const yy = cy + dy; if (yy < 0 || yy >= h) continue
      for (let dx = -win; dx <= win; dx++) {
        const xx = cx + dx; if (xx < 0 || xx >= w) continue
        const p = (yy * w + xx) * 4
        s += px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114; cnt++
      }
    }
    out[gx] = cnt ? s / cnt : 0
  }
  return out
}

/**
 * Barcode-strip luminance: averages the top `rows` grid rows per column. The
 * metadata barcode is painted identically across BARCODE_ROWS rows, so averaging
 * them down a column cancels camera noise and yields a much cleaner read than a
 * single row — which is what lets the enc / gridH fields survive a shaky capture.
 */
export function sampleBarcodeLum(
  px: Uint8ClampedArray, w: number, h: number, map: GridMap,
  gridW: number, gridH: number, rows: number,
): Float32Array {
  const nr = Math.max(1, Math.min(rows, gridH))
  const out = new Float32Array(gridW)
  const c0 = map(0, 0.5 / gridH), c1 = map(1, 0.5 / gridH)
  const cellPx = Math.hypot(c1.x - c0.x, c1.y - c0.y) / gridW
  const win = Math.max(0, Math.floor(cellPx / 4))
  for (let gx = 0; gx < gridW; gx++) {
    let s = 0, cnt = 0
    for (let r = 0; r < nr; r++) {
      const c = map((gx + 0.5) / gridW, (r + 0.5) / gridH)
      const cx = c.x | 0, cy = c.y | 0
      for (let dy = -win; dy <= win; dy++) {
        const yy = cy + dy; if (yy < 0 || yy >= h) continue
        for (let dx = -win; dx <= win; dx++) {
          const xx = cx + dx; if (xx < 0 || xx >= w) continue
          const p = (yy * w + xx) * 4
          s += px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114; cnt++
        }
      }
    }
    out[gx] = cnt ? s / cnt : 0
  }
  return out
}

/** Canvas-free core (testable): same as sampleWithRegistration on raw pixels. */
export function sampleWithRegistrationPixels(
  px: Uint8ClampedArray,
  w: number, h: number, gridW: number, gridH: number,
): CellReadings | null {
  const map = locateMatrixPixels(px, w, h)
  return map ? sampleHomography(px, w, h, map, gridW, gridH) : null
}

interface Pt { x: number; y: number }
interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }

/** True if opposite sides are close enough to each other (a real rectangle). */
function quadIsSquareEnough(q: Quad): boolean {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  const top = d(q.tl, q.tr), right = d(q.tr, q.br), bottom = d(q.br, q.bl), left = d(q.bl, q.tl)
  const hRatio = Math.min(top, bottom) / Math.max(top, bottom)
  const vRatio = Math.min(left, right) / Math.max(left, right)
  const minSide = Math.min(top, right, bottom, left)
  return minSide > 4 && hRatio > 0.45 && vRatio > 0.45
}

/**
 * Rotate the quad so the corner carrying the white orientation marker becomes
 * top-left. Samples brightness just inside the frame ring at each corner; the
 * marker corner reads bright, the other three dark. If no corner clearly wins
 * (marker occluded / not present), the geometric order is kept — so this can
 * only help, never regress. Rotation preserves winding (never mirrors).
 */
function orientQuad(px: Uint8ClampedArray, w: number, h: number, q: Quad): Quad {
  const cx = (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4
  const cy = (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4
  const lumIn = (p: Pt): number => {
    // Sample ~8% from the outer corner toward the centre → inside the frame ring.
    const sx = p.x + (cx - p.x) * 0.08, sy = p.y + (cy - p.y) * 0.08
    let s = 0, n = 0
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(sx) + dx, y = Math.round(sy) + dy
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const o = (y * w + x) * 4
      s += px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114; n++
    }
    return n ? s / n : 0
  }
  const corners = [q.tl, q.tr, q.br, q.bl]
  const b = corners.map(lumIn)
  let maxI = 0
  for (let i = 1; i < 4; i++) if (b[i] > b[maxI]) maxI = i
  const others = b.filter((_, i) => i !== maxI).sort((x, y) => x - y)
  const median = others[1]
  if (b[maxI] - median < 45) return q // no clear marker → keep geometric order
  const r = (i: number) => corners[(maxI + i) % 4]
  return { tl: r(0), tr: r(1), br: r(2), bl: r(3) }
}

/**
 * Corners via x±y extremes on the DOWNSAMPLED dark mask (within the located
 * component box), each then refined in a tiny full-res window. Robust for a
 * roughly-upright quad with small rotation/perspective, and ~100× cheaper than
 * a full-resolution region scan.
 */
function frameCornersFast(
  px: Uint8ClampedArray, w: number, h: number,
  dark: Uint8Array, sw: number, sh: number, sx: number, sy: number,
  box: Rect, t: number,
): Quad | null {
  const bx0 = Math.max(0, box.x - 1), by0 = Math.max(0, box.y - 1)
  const bx1 = Math.min(sw - 1, box.x + box.w + 1), by1 = Math.min(sh - 1, box.y + box.h + 1)
  let tl: Pt | null = null, tr: Pt | null = null, br: Pt | null = null, bl: Pt | null = null
  let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      if (!dark[y * sw + x]) continue
      const s = x + y, d = x - y
      if (s < minS) { minS = s; tl = { x, y } }
      if (s > maxS) { maxS = s; br = { x, y } }
      if (d > maxD) { maxD = d; tr = { x, y } }
      if (d < minD) { minD = d; bl = { x, y } }
    }
  }
  if (!tl || !tr || !br || !bl) return null

  const win = Math.ceil(Math.max(sx, sy) * 1.6) + 2
  const lumAt = (x: number, y: number) => {
    const p = (y * w + x) * 4
    return px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114
  }
  // Refine a downsampled corner: minimise `score` over dark pixels in a small
  // full-res window centred on the mapped point.
  const refine = (c: Pt, score: (x: number, y: number) => number): Pt => {
    const cx = Math.round(c.x * sx), cy = Math.round(c.y * sy)
    let best: Pt = { x: cx, y: cy }, bestV = Infinity
    for (let y = Math.max(0, cy - win); y <= Math.min(h - 1, cy + win); y++) {
      for (let x = Math.max(0, cx - win); x <= Math.min(w - 1, cx + win); x++) {
        if (lumAt(x, y) >= t) continue
        const v = score(x, y)
        if (v < bestV) { bestV = v; best = { x, y } }
      }
    }
    return best
  }
  return {
    tl: refine(tl, (x, y) => x + y),
    tr: refine(tr, (x, y) => y - x),
    br: refine(br, (x, y) => -(x + y)),
    bl: refine(bl, (x, y) => x - y),
  }
}

/** Projective map from the unit square (u,v)∈[0,1]² to the given quad. */
function homographyUnitSquareToQuad(p0: Pt, p1: Pt, p2: Pt, p3: Pt): (u: number, v: number) => Pt {
  // corners for uv = (0,0),(1,0),(1,1),(0,1)  (Heckbert square→quad)
  const x0 = p0.x, x1 = p1.x, x2 = p2.x, x3 = p3.x
  const y0 = p0.y, y1 = p1.y, y2 = p2.y, y3 = p3.y
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3
  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, hh: number
  const den = dx1 * dy2 - dx2 * dy1
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; hh = 0
  } else {
    g = (dx3 * dy2 - dx2 * dy3) / den
    hh = (dx1 * dy3 - dx3 * dy1) / den
    a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; c = x0
    d = y1 - y0 + g * y1; e = y3 - y0 + hh * y3; f = y0
  }
  return (u, v) => {
    const wgt = g * u + hh * v + 1
    return { x: (a * u + b * v + c) / wgt, y: (d * u + e * v + f) / wgt }
  }
}

function sampleHomography(
  px: Uint8ClampedArray, w: number, h: number,
  map: (u: number, v: number) => Pt, gridW: number, gridH: number,
  maxWindow = 2,
): CellReadings {
  const n = gridW * gridH
  const scratch = colorSamplingScratch(n)
  const { r, g, b, lum } = scratch
  const rel = scratch.rel!
  const c00 = map(0, 0), c10 = map(1, 0), c01 = map(0, 1)
  const cellPxW = Math.hypot(c10.x - c00.x, c10.y - c00.y) / gridW
  const cellPxH = Math.hypot(c01.x - c00.x, c01.y - c00.y) / gridH
  const cellPx = Math.min(cellPxW, cellPxH)
  // A 5×5 centre window is already larger than the useful Bayer footprint of
  // a photographed 64² Color8 cell. The former unbounded 7×7/9×9 window
  // nearly doubled sampling work and increasingly mixed neighbour symbols as the
  // matrix moved closer to the camera. Dense grids naturally select a smaller win.
  const win = Math.min(maxWindow, Math.max(0, Math.floor(cellPx / 4)))
  // A crisp, well-focused cell reads nearly UNIFORM inside its sampling window;
  // a blurred cell — or one straddling a neighbour because registration drifted —
  // reads with high internal luminance variance. We turn that variance into an
  // optical reliability in [0,1] and hand it to the soft demod, so belief
  // propagation trusts sharp cells and discounts smeared ones (the optically-
  // coupled soft-decision path). Saturated windows (clipped at 0/255) also lose
  // level information → down-weighted. `relScale` normalises against a nominal
  // one-level colour step (~64 codes) so the score is encoding-independent.
  const relScale = 1 / (28 * 28)
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const c = map((gx + 0.5) / gridW, (gy + 0.5) / gridH)
      const cx = c.x | 0, cy = c.y | 0
      let sr = 0, sg = 0, sb = 0, cnt = 0, sl = 0, sll = 0
      for (let dy = -win; dy <= win; dy++) {
        const yy = cy + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -win; dx <= win; dx++) {
          const xx = cx + dx
          if (xx < 0 || xx >= w) continue
          const p = (yy * w + xx) * 4
          const rr = px[p], gg = px[p + 1], bb = px[p + 2]
          sr += rr; sg += gg; sb += bb; cnt++
          const l = rr * 0.299 + gg * 0.587 + bb * 0.114
          sl += l; sll += l * l
        }
      }
      const i = gy * gridW + gx
      if (cnt === 0) { r[i] = g[i] = b[i] = lum[i] = 0; rel[i] = 0; continue }
      r[i] = sr / cnt; g[i] = sg / cnt; b[i] = sb / cnt
      lum[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114
      const varL = Math.max(0, sll / cnt - (sl / cnt) * (sl / cnt))
      // Sharp (low variance) → ~1; smeared → →0. Do not penalise clipping here:
      // Color8 intentionally uses 0/255 endpoints, so the old generic clipping
      // penalty made a perfectly focused binary-colour cell report only ~50%
      // confidence and unnecessarily weakened its LDPC LLR. Multi-level modes
      // already learn their endpoint spacing from Pilot anchors.
      const sharp = 1 / (1 + varL * relScale)
      rel[i] = sharp
    }
  }
  return { r, g, b, lum, rel }
}

/** Fallback: sample the centered region with no registration. */
export function sampleCentered(
  ctx: CanvasRenderingContext2D, w: number, h: number, gridW: number, gridH: number,
): CellReadings {
  const side = Math.min(w, h)
  const rect: Rect = { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side }
  const img = ctx.getImageData(0, 0, w, h)
  return sampleRect(img.data, w, h, rect, gridW, gridH)
}

function sampleRect(px: Uint8ClampedArray, w: number, _h: number, rect: Rect, gridW: number, gridH: number): CellReadings {
  const n = gridW * gridH
  const cw = rect.w / gridW, ch = rect.h / gridH
  const win = Math.max(1, Math.floor(Math.min(cw, ch) / 4))
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), lum = new Float32Array(n)
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = (rect.x + (gx + 0.5) * cw) | 0
      const cy = (rect.y + (gy + 0.5) * ch) | 0
      let sr = 0, sg = 0, sb = 0, cnt = 0
      for (let dy = -win; dy <= win; dy++) {
        const yy = cy + dy
        if (yy < 0 || yy >= _h) continue
        for (let dx = -win; dx <= win; dx++) {
          const xx = cx + dx
          if (xx < 0 || xx >= w) continue
          const p = (yy * w + xx) * 4
          sr += px[p]; sg += px[p + 1]; sb += px[p + 2]; cnt++
        }
      }
      const i = gy * gridW + gx
      r[i] = sr / cnt; g[i] = sg / cnt; b[i] = sb / cnt
      lum[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114
    }
  }
  return { r, g, b, lum }
}

function otsu(gray: Float32Array): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, gray[i] | 0))]++
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  // Track the plateau of maximum between-class variance and return its center.
  // A purely bimodal image (clean black/white) has one flat max plateau spanning
  // every valid threshold; returning its center gives ~mid-gray instead of 0.
  let sumB = 0, wB = 0, best = -1, lo = -1, hi = -1
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += i * hist[i]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; lo = hi = i }
    else if (between === best) hi = i
  }
  return lo < 0 ? 128 : (lo + hi) >> 1
}

/** Flood-fill connected components (8-conn); return the best frame candidate. */
function largestRectComponent(dark: Uint8Array, w: number, h: number): Rect | null {
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  // The transmitted matrix's black frame is wrapped by a WHITE quiet zone, so it
  // never reaches the image edge. The scene AROUND the matrix (dark desk, tablet
  // bezel, unlit room) is usually just as dark and forms one big component that
  // DOES touch the border — and its bounding box, being the whole frame, would
  // otherwise win on area and hijack registration (the map then locks onto the
  // background instead of the grid, and nothing decodes). So we score the best
  // border-touching and best interior component separately and PREFER the
  // interior one, only falling back to a border-touching region when no interior
  // candidate qualifies (e.g. the matrix is held right up to the frame edge).
  let best: Rect | null = null, bestScore = 0
  let bestEdge: Rect | null = null, bestEdgeScore = 0
  const minSide = Math.min(w, h) * 0.30

  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0
    let touchesEdge = false
    stack.length = 0
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const p = stack.pop()!
      const y = (p / w) | 0, x = p - y * w
      area++
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const q = ny * w + nx
          if (dark[q] && !seen[q]) { seen[q] = 1; stack.push(q) }
        }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1
    if (bw < minSide || bh < minSide) continue
    const square = Math.min(bw, bh) / Math.max(bw, bh)
    if (square < 0.3) continue
    // The matrix tile is the largest rectangular dark region (its bbox is
    // the frame's outer edge, whether the interior is hollow or filled).
    const score = bw * bh
    if (touchesEdge) {
      if (score > bestEdgeScore) { bestEdgeScore = score; bestEdge = { x: minX, y: minY, w: bw, h: bh } }
    } else if (score > bestScore) { bestScore = score; best = { x: minX, y: minY, w: bw, h: bh } }
  }
  return best ?? bestEdge
}
