// Hierarchical optical modulation for future high-resolution screen/camera pairs.
//
// Each 2×2 macrocell carries two independent binary codeword bits:
//   • base bit: the three non-key cells are all black or all white;
//   • enhancement bit: the key (top-left) cell is black or white.
// A high-resolution camera samples all four cells and receives two LDPC frames
// per displayed image. A lower-resolution camera sees their average and can still
// recover the robust base stream. There is no reverse channel and no device
// selection at the sender: the receiver simply takes the tier it can resolve.

import { BARCODE_ROWS } from './metaBarcode'
import type { CellReadings, EncodingSpec } from './visualCodec'

export interface HierarchicalLayout {
  gridW: number
  gridH: number
  dataRow: number
  macroW: number
  macroH: number
  macroCount: number
  /** Codeword bytes in each of the base/enhancement streams. */
  capacity: number
}

export interface HierarchicalLLRs {
  base: Float64Array
  enhancement: Float64Array
  layout: HierarchicalLayout
}

/** Align the payload to an even microcell row below the persistent barcode. */
export function hierarchicalLayout(spec: Pick<EncodingSpec, 'gridW' | 'gridH'>): HierarchicalLayout {
  const dataRow = BARCODE_ROWS + (BARCODE_ROWS & 1)
  const macroW = Math.floor(spec.gridW / 2)
  const macroH = Math.floor((spec.gridH - dataRow) / 2)
  const macroCount = Math.max(0, macroW * macroH)
  return { gridW: spec.gridW, gridH: spec.gridH, dataRow, macroW, macroH, macroCount, capacity: Math.floor(macroCount / 8) }
}

function bitAt(bytes: Uint8Array, index: number): number {
  return (bytes[index >> 3] >> (7 - (index & 7))) & 1
}

/** Encode two equal-sized LDPC codewords into one BW hierarchical image. */
export function encodeHierarchicalCells(base: Uint8Array, enhancement: Uint8Array, spec: Pick<EncodingSpec, 'gridW' | 'gridH'>): Uint8Array {
  const l = hierarchicalLayout(spec)
  if (base.length !== l.capacity || enhancement.length !== l.capacity) throw new Error('hierarchical frame capacity mismatch')
  const out = new Uint8Array(l.gridW * l.gridH * 3)
  for (let my = 0; my < l.macroH; my++) for (let mx = 0; mx < l.macroW; mx++) {
    const m = my * l.macroW + mx
    const b = bitAt(base, m), e = bitAt(enhancement, m)
    const x = mx * 2, y = l.dataRow + my * 2
    // Three reference cells carry the robust base. The key cell carries the
    // enhancement and only perturbs the low-resolution macro average by 25%.
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const bit = dx === 0 && dy === 0 ? e : b
      const p = ((y + dy) * l.gridW + x + dx) * 3
      const v = bit ? 255 : 0
      out[p] = out[p + 1] = out[p + 2] = v
    }
  }
  return out
}

/** Soft-demodulate both tiers. `base` remains valid even when the enhancement
 * key cells cannot be spatially resolved, because it uses all macro energy. */
export function softDemodHierarchical(rd: CellReadings, spec: Pick<EncodingSpec, 'gridW' | 'gridH'>): HierarchicalLLRs {
  const l = hierarchicalLayout(spec)
  const nBits = l.capacity * 8
  const base = new Float64Array(nBits), enhancement = new Float64Array(nBits)
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < rd.lum.length; i++) { const v = rd.lum[i]; if (v < mn) mn = v; if (v > mx) mx = v }
  const mid = (mn + mx) * 0.5, scale = 9 / Math.max(1, mx - mn)
  for (let my = 0; my < l.macroH; my++) for (let mx0 = 0; mx0 < l.macroW; mx0++) {
    const m = my * l.macroW + mx0
    if (m >= nBits) continue
    const x = mx0 * 2, y = l.dataRow + my * 2
    const p0 = y * l.gridW + x
    const key = rd.lum[p0]
    const refs = (rd.lum[p0 + 1] + rd.lum[p0 + l.gridW] + rd.lum[p0 + l.gridW + 1]) / 3
    const rel = rd.rel ? (rd.rel[p0] + rd.rel[p0 + 1] + rd.rel[p0 + l.gridW] + rd.rel[p0 + l.gridW + 1]) * 0.25 : 1
    // LLR > 0 means bit 0, matching the rest of the visual codec.
    base[m] = (mid - refs) * scale * rel
    enhancement[m] = (mid - key) * scale * rel
  }
  return { base, enhancement, layout: l }
}

/** Seed schedule for the future dual-stream fountain wrapper. The base tier gets
 * every even systematic chunk then repairs; a high-tier camera simultaneously
 * receives the odd chunks and therefore closes roughly twice as fast. */
export function hierarchicalSeeds(k: number, tick: number): { base: number; enhancement: number } {
  const evenCount = Math.ceil(k / 2), oddCount = Math.floor(k / 2)
  const base = tick < evenCount ? tick * 2 + 1 : k + 1 + (tick - evenCount) * 2
  const enhancement = tick < oddCount ? tick * 2 + 2 : k + 2 + Math.max(0, tick - oddCount) * 2
  return { base, enhancement }
}
