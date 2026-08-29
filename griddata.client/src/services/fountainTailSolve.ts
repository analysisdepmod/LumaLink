export interface DenseTailRow {
  vars: number[]
  data: Uint8Array
}

export interface DenseTailValue {
  index: number
  data: Uint8Array
}

interface PackedRow {
  bits: Uint32Array
  data: Uint8Array
}

interface Workspace {
  sourceByColumn: number[]
  rows: PackedRow[]
  basis: Array<PackedRow | null>
}

function xorPayload(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length)
  const words = n >>> 2
  // Tail rows are worker-owned slices and therefore start at aligned offsets.
  // Four bytes per operation cuts the dominant 902-byte row XOR substantially;
  // retain a byte fallback for unusual callers/subarrays.
  if ((dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, words)
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words)
    for (let i = 0; i < words; i++) d32[i] ^= s32[i]
    for (let i = words << 2; i < n; i++) dst[i] ^= src[i]
  } else {
    for (let i = 0; i < n; i++) dst[i] ^= src[i]
  }
}

function prepare(rows: DenseTailRow[], missing: number): Workspace | null {
  const sourceSet = new Set<number>()
  for (const row of rows) for (const source of row.vars) sourceSet.add(source)
  if (sourceSet.size !== missing) return null
  const sourceByColumn = [...sourceSet].sort((a, b) => a - b)
  const columnBySource = new Map(sourceByColumn.map((source, column) => [source, column]))
  const wordCount = Math.ceil(missing / 32)
  const packed = rows.map(row => {
    const bits = new Uint32Array(wordCount)
    for (const source of row.vars) {
      const column = columnBySource.get(source)!
      bits[column >>> 5] |= (1 << (column & 31)) >>> 0
    }
    return { bits, data: row.data }
  })
  return { sourceByColumn, rows: packed, basis: new Array<PackedRow | null>(missing).fill(null) }
}

function firstSetBit(bits: Uint32Array): number {
  for (let wordIndex = 0; wordIndex < bits.length; wordIndex++) {
    const word = bits[wordIndex]
    if (word) return (wordIndex << 5) + 31 - Math.clz32(word & -word)
  }
  return -1
}

function insertBasis(row: PackedRow, basis: Array<PackedRow | null>): void {
  while (true) {
    const pivot = firstSetBit(row.bits)
    if (pivot < 0) return
    const prior = basis[pivot]
    if (!prior) { basis[pivot] = row; return }
    for (let word = 0; word < row.bits.length; word++) row.bits[word] ^= prior.bits[word]
    xorPayload(row.data, prior.data)
  }
}

function finish(workspace: Workspace, missing: number): DenseTailValue[] | null {
  if (workspace.basis.some(row => row == null)) return null
  const values: Array<Uint8Array | null> = new Array(missing).fill(null)
  for (let pivot = missing - 1; pivot >= 0; pivot--) {
    const row = workspace.basis[pivot]!
    const value = row.data.slice()
    for (let wordIndex = pivot >>> 5; wordIndex < row.bits.length; wordIndex++) {
      let word = row.bits[wordIndex]
      while (word) {
        const low = word & -word
        const column = (wordIndex << 5) + 31 - Math.clz32(low)
        word ^= low
        if (column === pivot || column >= missing) continue
        const known = values[column]
        if (!known) return null
        xorPayload(value, known)
      }
    }
    values[pivot] = value
  }
  return values.map((data, column) => ({ index: workspace.sourceByColumn[column], data: data! }))
}

/** Bounded packed-bit GF(2) elimination used by tests and the worker fallback. */
export function solveDenseTail(rows: DenseTailRow[], missing: number): DenseTailValue[] | null {
  const workspace = prepare(rows, missing)
  if (!workspace) return null
  for (const row of workspace.rows) insertBasis(row, workspace.basis)
  return finish(workspace, missing)
}

/**
 * Browser-worker variant. Bit-packed variables replace Set symmetric-difference,
 * and Uint32 payload XOR replaces byte-at-a-time elimination. Yield only between
 * eight-row batches: enough to share memory bandwidth with camera workers without
 * stretching a solvable optical tail across several more display seconds.
 */
export async function solveDenseTailYielding(
  rows: DenseTailRow[],
  missing: number,
  yieldControl: () => Promise<void>,
): Promise<DenseTailValue[] | null> {
  const workspace = prepare(rows, missing)
  if (!workspace) return null
  for (let rowIndex = 0; rowIndex < workspace.rows.length; rowIndex++) {
    insertBasis(workspace.rows[rowIndex], workspace.basis)
    if ((rowIndex & 7) === 7) await yieldControl()
  }
  await yieldControl()
  return finish(workspace, missing)
}
