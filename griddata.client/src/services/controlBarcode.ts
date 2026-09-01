// LumaLink v11 fast control channel.
//
// Row 1 of a v3 metadata header carries one of ten CRC-protected pages.  The
// receiver can therefore allocate its Fountain decoder before a full LDPC
// manifest happens to arrive.  The descriptive manifest (name/MIME/SHA) remains
// authoritative and is still required before finalisation.

const SYNC = [1, 1, 0, 1] as const
const TYPE = 2 // two-bit discriminator: binary 10
const PAGE_COUNT = 10
const PAYLOAD_BITS = 10
const DATA_BITS = 21 // type(2) + page(4) + transfer tag(5) + payload(10)
const CRC_BITS = 7
const BAR_CELLS = 2
const PATTERN_BITS = 32

export interface TransferControl {
  id: number
  k: number
  chunk: number
  comp: number
}

export interface TransferControlPage {
  page: number
  tag: number
  payload: number
}

function crc7(bits: readonly number[]): number {
  let crc = 0
  for (const bit of bits) {
    const feedback = ((crc >>> 6) & 1) ^ (bit & 1)
    crc = (crc << 1) & 0x7f
    if (feedback) crc ^= 0x09
  }
  return crc
}

function intBits(value: number, count: number): number[] {
  const out = new Array<number>(count)
  for (let index = 0; index < count; index++)
    out[index] = (value >>> (count - index - 1)) & 1
  return out
}

function bitsInt(bits: readonly number[], offset: number, count: number): number {
  let value = 0
  for (let index = 0; index < count; index++) value = value * 2 + (bits[offset + index] & 1)
  return value >>> 0
}

function descriptorBits(control: TransferControl): number[] {
  return [
    ...intBits(control.id >>> 0, 32),
    ...intBits(control.k, 20),
    ...intBits(control.chunk, 16),
    ...intBits(control.comp, 30),
  ]
}

function transferTag(id: number): number {
  id >>>= 0
  return ((id ^ (id >>> 5) ^ (id >>> 13) ^ (id >>> 21)) & 0x1f) >>> 0
}

export function controlPage(control: TransferControl, page: number): TransferControlPage {
  page = ((Math.floor(page) % PAGE_COUNT) + PAGE_COUNT) % PAGE_COUNT
  const bits = descriptorBits(control)
  let payload = 0
  for (let bit = 0; bit < PAYLOAD_BITS; bit++)
    payload = (payload << 1) | (bits[page * PAYLOAD_BITS + bit] ?? 0)
  return { page, tag: transferTag(control.id), payload }
}

export function encodeControlBarcodeRow(control: TransferControl, page: number, gridW: number): Uint8Array {
  const p = controlPage(control, page)
  const data = [
    ...intBits(TYPE, 2),
    ...intBits(p.page, 4),
    ...intBits(p.tag, 5),
    ...intBits(p.payload, PAYLOAD_BITS),
  ]
  const pattern = [...SYNC, ...data, ...intBits(crc7(data), CRC_BITS)]
  const out = new Uint8Array(gridW * 3)
  for (let cell = 0; cell < gridW; cell++) {
    const bit = pattern[Math.floor(cell / BAR_CELLS) % PATTERN_BITS]
    const value = bit ? 239 : 16
    out[cell * 3] = out[cell * 3 + 1] = out[cell * 3 + 2] = value
  }
  return out
}

export function decodeControlBarcodeRow(lum: Float32Array, cellCount: number): TransferControlPage | null {
  if (cellCount < PATTERN_BITS * BAR_CELLS) return null
  for (let phase = 0; phase < BAR_CELLS; phase++) {
    const barCount = Math.floor((cellCount - phase) / BAR_CELLS)
    if (barCount < PATTERN_BITS) continue
    const bars = new Float32Array(barCount)
    for (let bar = 0; bar < barCount; bar++) {
      let sum = 0
      for (let cell = 0; cell < BAR_CELLS; cell++) sum += lum[phase + bar * BAR_CELLS + cell]
      bars[bar] = sum / BAR_CELLS
    }
    const sorted = Float32Array.from(bars).sort()
    let threshold = (sorted[0] + sorted[barCount - 1]) / 2
    let gap = -1
    for (let index = 1; index < barCount; index++) {
      const candidate = sorted[index] - sorted[index - 1]
      if (candidate > gap) { gap = candidate; threshold = (sorted[index] + sorted[index - 1]) / 2 }
    }
    const bits = Array.from(bars, value => value > threshold ? 1 : 0)
    for (let offset = 0; offset <= Math.min(4, barCount - PATTERN_BITS); offset++) {
      if (SYNC.some((bit, index) => bits[offset + index] !== bit)) continue
      const data = bits.slice(offset + SYNC.length, offset + SYNC.length + DATA_BITS)
      if (bitsInt(data, 0, 2) !== TYPE) continue
      if (crc7(data) !== bitsInt(bits, offset + SYNC.length + DATA_BITS, CRC_BITS)) continue
      const page = bitsInt(data, 2, 4)
      if (page >= PAGE_COUNT) continue
      return { page, tag: bitsInt(data, 6, 5), payload: bitsInt(data, 11, PAYLOAD_BITS) }
    }
  }
  return null
}

export class TransferControlAssembler {
  private tag = -1
  private readonly pages = new Map<number, number>()

  reset(): void { this.tag = -1; this.pages.clear() }

  add(page: TransferControlPage): TransferControl | null {
    if (this.tag !== page.tag) { this.tag = page.tag; this.pages.clear() }
    this.pages.set(page.page, page.payload)
    if (this.pages.size < PAGE_COUNT) return null
    const bits: number[] = []
    for (let index = 0; index < PAGE_COUNT; index++) {
      const payload = this.pages.get(index)
      if (payload == null) return null
      bits.push(...intBits(payload, PAYLOAD_BITS))
    }
    const control: TransferControl = {
      id: bitsInt(bits, 0, 32),
      k: bitsInt(bits, 32, 20),
      chunk: bitsInt(bits, 52, 16),
      comp: bitsInt(bits, 68, 30),
    }
    if (transferTag(control.id) !== this.tag || control.k < 1 || control.chunk < 1 || control.comp < 0)
      return null
    return control
  }
}

export const CONTROL_BARCODE_ROW = 1
export const CONTROL_PAGE_COUNT = PAGE_COUNT
