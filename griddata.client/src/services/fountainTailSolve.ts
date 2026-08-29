export interface DenseTailRow {
  vars: number[]
  data: Uint8Array
}

export interface DenseTailValue {
  index: number
  data: Uint8Array
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length)
  for (let i = 0; i < n; i++) dst[i] ^= src[i]
}

/** Bounded GF(2) elimination used by both the browser worker and test fallback. */
export function solveDenseTail(rows: DenseTailRow[], missing: number): DenseTailValue[] | null {
  const basis = new Map<number, { vars: Set<number>; data: Uint8Array }>()
  for (const row of rows) {
    const vars = new Set(row.vars)
    const data = row.data
    while (vars.size > 0) {
      let pivot = Number.MAX_SAFE_INTEGER
      for (const index of vars) if (index < pivot) pivot = index
      const prior = basis.get(pivot)
      if (!prior) { basis.set(pivot, { vars, data }); break }
      for (const index of prior.vars) {
        if (vars.has(index)) vars.delete(index)
        else vars.add(index)
      }
      xorInto(data, prior.data)
    }
  }
  if (basis.size < missing) return null

  const values = new Map<number, Uint8Array>()
  for (const pivot of [...basis.keys()].sort((a, b) => b - a)) {
    const row = basis.get(pivot)!
    const value = row.data.slice()
    let ready = true
    for (const index of row.vars) {
      if (index === pivot) continue
      const known = values.get(index)
      if (!known) { ready = false; break }
      xorInto(value, known)
    }
    if (ready) values.set(pivot, value)
  }
  if (values.size !== missing) return null
  return [...values].map(([index, data]) => ({ index, data }))
}

/**
 * Browser-worker variant that yields between small elimination batches. The
 * total work is identical to `solveDenseTail`, but it no longer monopolises a
 * CPU core/memory bandwidth long enough to starve the camera decode workers.
 */
export async function solveDenseTailYielding(
  rows: DenseTailRow[],
  missing: number,
  yieldControl: () => Promise<void>,
): Promise<DenseTailValue[] | null> {
  const basis = new Map<number, { vars: Set<number>; data: Uint8Array }>()
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    const vars = new Set(row.vars)
    const data = row.data
    while (vars.size > 0) {
      let pivot = Number.MAX_SAFE_INTEGER
      for (const index of vars) if (index < pivot) pivot = index
      const prior = basis.get(pivot)
      if (!prior) { basis.set(pivot, { vars, data }); break }
      for (const index of prior.vars) {
        if (vars.has(index)) vars.delete(index)
        else vars.add(index)
      }
      xorInto(data, prior.data)
    }
    if ((rowIndex & 1) === 1) await yieldControl()
  }
  if (basis.size < missing) return null

  const values = new Map<number, Uint8Array>()
  const pivots = [...basis.keys()].sort((a, b) => b - a)
  for (let pivotIndex = 0; pivotIndex < pivots.length; pivotIndex++) {
    const pivot = pivots[pivotIndex]
    const row = basis.get(pivot)!
    const value = row.data.slice()
    let ready = true
    for (const index of row.vars) {
      if (index === pivot) continue
      const known = values.get(index)
      if (!known) { ready = false; break }
      xorInto(value, known)
    }
    if (ready) values.set(pivot, value)
    if ((pivotIndex & 3) === 3) await yieldControl()
  }
  if (values.size !== missing) return null
  return [...values].map(([index, data]) => ({ index, data }))
}
