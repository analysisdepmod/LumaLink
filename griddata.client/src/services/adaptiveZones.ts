// Adaptive Spatial Coding — zone-based encoding.
//
// The camera's optical channel is NOT uniform across the grid: the centre of the
// frame is sharper, better-exposed, and less distorted than the edges. Fixed
// encoding wastes the centre (could carry more bits) or loses the edges (too
// many errors at high colour levels). Adaptive zoning fixes this by assigning a
// DENSE encoding to the reliable centre and a ROBUST encoding to the weaker
// periphery — like water-filling in radio communications, but for light.
//
// Zone layout: concentric rectangular rings. The innermost ring uses the densest
// encoding the cell size allows; each outer ring steps down one level. Zone
// boundaries are stored in the manifest so the receiver knows exactly which cells
// to demod at which level.

import type { Encoding } from './visualCodec'

export interface Zone {
  enc: Encoding
  x0: number; y0: number  // top-left cell (inclusive)
  x1: number; y1: number  // bottom-right cell (exclusive)
  cellCount: number
}

export interface ZoneMap {
  zones: Zone[]
  gridW: number
  gridH: number
}

export const ENC_ORDER: Encoding[] = ['color64', 'color32', 'color16', 'color8', 'bw']
export const BITS_PER_CELL: Record<Encoding, number> = { color64: 6, color32: 5, color16: 4, color8: 3, bw: 1 }

export function encIndex(enc: Encoding): number { return ENC_ORDER.indexOf(enc) }
export function bitsPerCellEnc(enc: Encoding): number { return BITS_PER_CELL[enc] }

/**
 * Build a concentric zone map for a grid of `gridW × gridH` cells.
 * `centerEnc` is the densest encoding for the centre ring; outer rings step
 * down one level each. `ringWidth` is the width (in cells) of each ring.
 */
export function buildZoneMap(
  gridW: number, gridH: number,
  centerEnc: Encoding = 'color64',
  ringWidth = 0,
): ZoneMap {
  const ci = encIndex(centerEnc)
  // Default ring width: ~15% of the short side, minimum 4 cells
  const rw = ringWidth || Math.max(4, Math.round(Math.min(gridW, gridH) * 0.15))

  const zones: Zone[] = []
  let level = ci

  // Build rings from centre outward by shrinking the remaining rectangle
  let x0 = 0, y0 = 0, x1 = gridW, y1 = gridH
  const rings: { x0: number; y0: number; x1: number; y1: number }[] = []

  // Peel outer rings first (they get the weaker encoding)
  while (x1 - x0 > rw * 2 && y1 - y0 > rw * 2 && level < ENC_ORDER.length - 1) {
    rings.push({ x0, y0, x1, y1 })
    x0 += rw; y0 += rw; x1 -= rw; y1 -= rw
    level++
  }
  // Whatever's left is the centre ring
  rings.push({ x0, y0, x1, y1 })

  // Reverse: centre gets densest, outer gets weakest
  rings.reverse()
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]
    const enc = ENC_ORDER[Math.min(ci + i, ENC_ORDER.length - 1)]
    const count = (r.x1 - r.x0) * (r.y1 - r.y0)
    // Subtract inner rings' cell counts for the ring-shaped zones
    const innerCount = i > 0
      ? (rings[i - 1].x1 - rings[i - 1].x0) * (rings[i - 1].y1 - rings[i - 1].y0)
      : 0
    // Skip if this ring has no cells
    if (count - innerCount <= 0) continue
    zones.push({ enc, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, cellCount: count - innerCount })
  }

  // Simplify: if all zones ended up with the same encoding, collapse to one
  if (zones.length > 1 && zones.every(z => z.enc === zones[0].enc)) {
    return { zones: [{ enc: zones[0].enc, x0: 0, y0: 0, x1: gridW, y1: gridH, cellCount: gridW * gridH }], gridW, gridH }
  }

  return { zones, gridW, gridH }
}

/**
 * Total capacity in bits of a zone map — each zone contributes its cell count
 * times the bits-per-cell of its encoding.
 */
export function zoneCapacityBits(zm: ZoneMap): number {
  let total = 0
  for (const z of zm.zones) total += z.cellCount * BITS_PER_CELL[z.enc]
  return total
}

/**
 * For each cell (row-major), determine which zone it belongs to and return
 * its encoding. Used by both encoder and decoder.
 */
export function cellZoneEnc(zm: ZoneMap, cellIndex: number): Encoding {
  const gx = cellIndex % zm.gridW
  const gy = Math.floor(cellIndex / zm.gridW)
  // Zones are ordered centre→outer; find the innermost that contains this cell
  for (const z of zm.zones) {
    if (gx >= z.x0 && gx < z.x1 && gy >= z.y0 && gy < z.y1) return z.enc
  }
  return zm.zones[zm.zones.length - 1]?.enc ?? 'color8'
}

/**
 * Compact serialisation for the manifest: `[ringWidth, centerEncIndex]`.
 * The receiver can rebuild the full zone map from these two numbers + the
 * grid dimensions already in the manifest.
 */
export function serializeZoneMap(ringWidth: number, centerEnc: Encoding): [number, number] {
  return [ringWidth, encIndex(centerEnc)]
}

export function deserializeZoneMap(gridW: number, gridH: number, data: [number, number]): ZoneMap {
  const [rw, ci] = data
  return buildZoneMap(gridW, gridH, ENC_ORDER[ci] ?? 'color64', rw)
}

/**
 * Compute the throughput advantage of adaptive zones vs uniform encoding.
 */
export function adaptiveGain(zm: ZoneMap, uniformEnc: Encoding): number {
  const adaptive = zoneCapacityBits(zm)
  const uniform = zm.gridW * zm.gridH * BITS_PER_CELL[uniformEnc]
  return adaptive / uniform
}

/**
 * Build a flat array mapping each cell (row-major) to its zone encoding.
 * Cached per zone map identity for fast lookups during encode/decode.
 */
export function buildCellEncArray(zm: ZoneMap): Encoding[] {
  const n = zm.gridW * zm.gridH
  const arr = new Array<Encoding>(n)
  for (let i = 0; i < n; i++) arr[i] = cellZoneEnc(zm, i)
  return arr
}

/** Is this zone map non-trivial (more than one distinct encoding)? */
export function isMultiZone(zm: ZoneMap): boolean {
  return zm.zones.length > 1
}
