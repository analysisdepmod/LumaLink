// Self-contained visual-transfer codec (runs entirely in the browser).
//
// Pipeline (sender):   bytes → deflate → K fixed chunks → systematic fountain
//                      → pack [type|seed|len|payload|crc] → LDPC codeword
//                      → interleave → colour grid → screen
// Pipeline (receiver): camera grid → optical soft-demod (per-bit LLR, weighted
//                      by each cell's optical reliability) → de-interleave
//                      → temporal soft-combine per seed → LDPC belief-propagation
//                      → CRC → fountain peel → inflate → file/text
//
// Frames are rateless (fountain / LT codes): the receiver only needs *any*
// ~K distinct frames to rebuild the data, which is what makes "resume" and
// noise tolerance work — a dropped or corrupted frame is simply ignored and
// the next good one carries the transfer forward.
//
// ── ECC: LDPC only ──
// The inner code is a soft-decision IRA-LDPC decoded with belief propagation on
// per-bit LLRs coming straight from the optical demod. Reed-Solomon (hard
// symbol decisions) and Hadamard spreading were removed: they discard the
// per-cell confidence the camera actually gives us, which is exactly the
// information the joint soft decoder needs. See ldpc.ts / wht.ts.

import { crc32 } from './crc32'
import { compress, decompress, packPayload, sha256Hex, unpackPayload, type PackedPayload } from './compress'
import { indicesForSeed } from './fountainDecoder'
import { capacityBytes, capacityBytesZoned, bytesToBits, bitsToBytes, specRate, DEFAULT_RATE, type Encoding, type EncodingSpec, type ZoneMap } from './visualCodec'
import { deserializeZoneMap, serializeZoneMap } from './adaptiveZones'
import { makeLdpcKM, ldpcEncodeParity, ldpcDecode, type LdpcCode } from './ldpc'

const MANIFEST_SUBHEADER = 2 // [partIndex, partCount] prefix on manifest payloads

export const HEADER_BYTES = 9   // type(1) + seed(4) + len(4)
export const CRC_BYTES = 4
export const FRAME_TYPE_MANIFEST = 0
export const FRAME_TYPE_DATA = 1
export const FRAME_TYPE_SOLO = 2 // whole transfer in one static frame

export interface TransferManifest {
  v: 1 | 2 | 3 | 4 | 5 | 6
  id: number            // random id — receiver detects a new transfer by this
  kind: 'file' | 'text'
  name: string          // filename ('' for text)
  mime: string          // MIME type
  total: number         // original (uncompressed) byte length
  comp: number          // compressed byte length
  compressed?: boolean  // v2: false for already-compressed payloads
  sha256?: string       // v2: SHA-256 of the original bytes, hex encoded
  k: number             // number of chunks
  chunk: number         // chunk size in bytes
  enc: Encoding         // visual encoding
  gridW: number         // grid columns
  gridH: number         // grid rows
  rate: number          // LDPC code rate used for this transfer's frames
  fps?: number          // sender display rate; receiver uses it to avoid duplicate captures
  zones?: [number, number] // adaptive spatial coding: [ringWidth, centerEncIndex]
}

/** Reject malformed optical metadata before it can allocate an unbounded decoder. */
export function isValidManifest(value: unknown): value is TransferManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<TransferManifest>
  const encOk = m.enc === 'bw' || m.enc === 'color8' || m.enc === 'color16' || m.enc === 'color32' || m.enc === 'color64'
  const finite = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max
  const gridW = m.gridW
  const gridH = m.gridH
  return (m.v === 1 || m.v === 2 || m.v === 3 || m.v === 4 || m.v === 5 || m.v === 6)
    && finite(m.id, 0, 0xFFFF_FFFF)
    && (m.kind === 'file' || m.kind === 'text')
    && typeof m.name === 'string' && m.name.length <= 512
    && typeof m.mime === 'string' && m.mime.length <= 256
    && finite(m.total, 0, 1_073_741_824)
    && finite(m.comp, 0, 1_073_741_824)
    && finite(m.k, 1, 1_000_000)
    && finite(m.chunk, 1, 1_048_576)
    && encOk
    && finite(gridW, 40, 256) && gridW % 8 === 0
    && finite(gridH, 8, 504) && gridH % 8 === 0
    && typeof m.rate === 'number' && m.rate >= 0.4 && m.rate <= 0.95
}

export interface BuildOptions {
  spec: EncodingSpec
  chunkSize: number         // payload bytes per data frame (≤ maxPayload)
  frameCount: number        // number of fountain data frames to emit
  manifestEvery?: number    // re-insert a manifest every N data frames (default 96)
  zoneMap?: ZoneMap          // adaptive spatial coding zone map
  zoneRingWidth?: number     // ring width used to build the zone map (for manifest)
  fps?: number               // actual display rate selected by the sender
  /** Direct source frames emitted between repair equations (Fast can use a longer run). */
  systematicRun?: number
}

export interface BuiltTransfer {
  /** Returns the ordered optical frame at an index without retaining every frame. */
  frameAt: (index: number) => Uint8Array
  frameCount: number
  /** Compatibility display metadata; it contains no encoded frame bytes. */
  frames: { length: number }
  manifest: TransferManifest
  /** Optical rate carried by the fixed barcode while decoding the manifest. */
  bootstrapRate: number
  capacity: number          // bytes per frame (full grid capacity)
  dataFrameCount: number
  static: boolean           // true = one self-contained frame, no animation
}

export interface SoloContent {
  kind: 'file' | 'text'
  name: string
  mime: string
  bytes: Uint8Array         // reconstructed original bytes
}

interface SoloMeta {
  kind: 'file' | 'text'
  name: string
  mime: string
  compressed?: boolean
  sha256?: string
}

/** Message-data bytes a full frame carries before header/CRC. */
export function frameDataBytes(spec: EncodingSpec, zm?: ZoneMap): number {
  const cap = zm ? capacityBytesZoned(zm) : capacityBytes(spec)
  return ldpcMessageBytes(cap, specRate(spec))
}

/** Largest usable payload (chunk) for an encoding spec. */
export function maxPayload(spec: EncodingSpec, zm?: ZoneMap): number {
  return frameDataBytes(spec, zm) - HEADER_BYTES - CRC_BYTES
}

/** Rebuild the EncodingSpec a manifest describes. */
export function specFromManifest(m: TransferManifest): EncodingSpec {
  return { enc: m.enc, gridW: m.gridW, gridH: m.gridH, rate: m.rate }
}

/** Rebuild the zone map from a manifest, if zones are present. */
export function zoneMapFromManifest(m: TransferManifest): ZoneMap | null {
  if (!m.zones) return null
  return deserializeZoneMap(m.gridW, m.gridH, m.zones)
}

// ── Interleaving ──
// A blur smear or glare spot corrupts a CONTIGUOUS patch of cells → a burst of
// bad bits. LDPC belief propagation degrades if many wired bits of one check
// fail together, so we transmit the codeword bytes in a scrambled order: any
// contiguous on-screen burst is spread across the whole Tanner graph, leaving
// each parity check only a few unreliable bits it can still resolve from its
// neighbours. The permutation depends only on `capacity`
// (a Fisher-Yates shuffle seeded by it), so sender and receiver derive the same
// one without any side-channel — even the very first manifest frame de-scrambles.
const permCache = new Map<number, Uint32Array>()
function framePermutation(capacity: number): Uint32Array {
  const cached = permCache.get(capacity)
  if (cached) return cached
  const p = new Uint32Array(capacity)
  for (let i = 0; i < capacity; i++) p[i] = i
  let s = (capacity ^ 0x9e3779b9) >>> 0
  const rnd = () => { // mulberry32
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = capacity - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const tmp = p[i]; p[i] = p[j]; p[j] = tmp }
  permCache.set(capacity, p)
  return p
}
/** Scramble frame bytes for transmission: out[i] = frame[perm[i]]. */
function interleave(frame: Uint8Array): Uint8Array {
  const perm = framePermutation(frame.length)
  const out = new Uint8Array(frame.length)
  for (let i = 0; i < frame.length; i++) out[i] = frame[perm[i]]
  return out
}

// ── Codeword whitening (anti-flicker) ──
// A manifest frame carries a small, zero-padded payload, so its LDPC codeword is
// mostly zeros → mapped to cells it renders noticeably DARKER than the busy data
// frames. Cycling data→manifest→data every N frames then reads as a periodic
// FLICKER on screen. We XOR every codeword with a fixed pseudo-random ±mask
// before it hits the cells, so EVERY frame — whatever its payload — has a
// balanced, uniform brightness/colour distribution and the flicker disappears.
// The mask depends only on the bit length (sender and receiver derive the same
// one), and the receiver undoes it at the LLR level by flipping the sign of the
// masked bits before LDPC decoding.
const whiteCache = new Map<number, Uint8Array>()
function frameWhiteMask(nbits: number): Uint8Array {
  const cached = whiteCache.get(nbits)
  if (cached) return cached
  const w = new Uint8Array(nbits)
  let s = (nbits ^ 0x5bd1e995) >>> 0
  for (let i = 0; i < nbits; i++) {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    w[i] = ((t ^ (t >>> 14)) >>> 0) & 1
  }
  whiteCache.set(nbits, w)
  return w
}

// ── LDPC soft-decision frame codec ──
// The frame footprint is `capacity` bytes → cells. The ECC is an LDPC codeword
// decoded with SOFT per-bit LLRs from the colour demod. On a noisy
// colour read this recovers frames the hard RS path drops. Only for the
// calibrated multi-level colour encodings (they expose clean soft info).
const ldpcCodeCache = new Map<string, LdpcCode>()
/** Message BYTES carried by an LDPC frame of `capacity` codeword bytes at `rate`. */
export function ldpcMessageBytes(capacity: number, rate: number = DEFAULT_RATE): number {
  return Math.max(HEADER_BYTES + CRC_BYTES + 1, Math.floor(capacity * rate))
}
function ldpcCodeFor(capacity: number, rate: number = DEFAULT_RATE): LdpcCode {
  const key = capacity + ':' + rate
  const cached = ldpcCodeCache.get(key)
  if (cached) return cached
  const k = ldpcMessageBytes(capacity, rate) * 8 // message bits
  const m = capacity * 8 - k                      // parity bits (fills the frame)
  const code = makeLdpcKM(k, m, 3)
  ldpcCodeCache.set(key, code)
  return code
}

export function packFrameLdpc(type: number, seed: number, payload: Uint8Array, capacity: number, rate: number = DEFAULT_RATE): Uint8Array {
  const M = ldpcMessageBytes(capacity, rate)
  const msg = new Uint8Array(M)
  const dv = new DataView(msg.buffer)
  const usable = M - HEADER_BYTES - CRC_BYTES
  const len = Math.min(payload.length, usable)
  msg[0] = type
  dv.setUint32(1, seed >>> 0, true)
  dv.setUint32(5, len, true)
  msg.set(payload.subarray(0, len), HEADER_BYTES)
  dv.setUint32(M - CRC_BYTES, crc32(msg, 0, M - CRC_BYTES), true)
  const code = ldpcCodeFor(capacity, rate)
  const msgBits = bytesToBits(msg)                 // k bits
  const parity = ldpcEncodeParity(code, msgBits)   // m bits
  const cw = new Uint8Array(code.n)
  cw.set(msgBits, 0); cw.set(parity, code.k)        // [message | parity]
  const mask = frameWhiteMask(code.n)               // balance brightness (anti-flicker)
  for (let i = 0; i < code.n; i++) cw[i] ^= mask[i]
  return interleave(bitsToBytes(cw))                // n bits = capacity bytes
}

/** Undo the byte-interleave at the LLR level (each byte = 8 consecutive LLRs). */
function deinterleaveLLR(llr: Float64Array, capacity: number): Float64Array {
  const perm = framePermutation(capacity)
  const out = new Float64Array(capacity * 8)
  for (let i = 0; i < capacity; i++) {
    const src = i * 8, dst = perm[i] * 8
    for (let b = 0; b < 8; b++) out[dst + b] = llr[src + b]
  }
  return out
}

/**
 * Soft parse: `llr` holds per-frame-bit LLRs (LLR>0 favours bit 0) in transmitted
 * order (from softDemodLLR). De-interleaves, LDPC-decodes, validates CRC. Null if
 * unrecoverable.
 */
export function parseFrameLdpcSoft(
  llr: Float64Array,
  capacity: number,
  rate: number = DEFAULT_RATE,
  fastOnly = false,
  maxBpIters = 24,
): ParsedFrame | null {
  if (llr.length < capacity * 8) return null
  const code = ldpcCodeFor(capacity, rate)
  const cwLlr = deinterleaveLLR(llr, capacity)      // [message | parity] order
  // Undo codeword whitening: a masked bit was flipped, so its LLR sign flips.
  const mask = frameWhiteMask(code.n)
  for (let i = 0; i < code.n; i++) if (mask[i]) cwLlr[i] = -cwLlr[i]
  const M = ldpcMessageBytes(capacity, rate)

  const check = (msgBits: Uint8Array): ParsedFrame | null => {
    const msg = bitsToBytes(msgBits).subarray(0, M)
    const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength)
    if (dv.getUint32(M - CRC_BYTES, true) !== crc32(msg, 0, M - CRC_BYTES)) return null
    const type = msg[0]
    const seed = dv.getUint32(1, true)
    const len = dv.getUint32(5, true)
    if (len > M - HEADER_BYTES - CRC_BYTES) return null
    return { type, seed, payload: msg.slice(HEADER_BYTES, HEADER_BYTES + len) }
  }

  // FAST PATH: the code is systematic (message bits are the first k codeword bits),
  // so take a hard decision on them and test the CRC directly. On a clean read this
  // passes immediately and we SKIP the expensive belief-propagation entirely —
  // restoring RS-like scan speed for easy modes (bw/color8). Only genuinely noisy
  // frames fall through to the full soft decoder below.
  const hard = new Uint8Array(code.k)
  for (let i = 0; i < code.k; i++) hard[i] = cwLlr[i] < 0 ? 1 : 0
  const fast = check(hard)
  if (fast) return fast

  // `fastOnly` is used by the auto-detect SEARCH: it tries many wrong candidate
  // specs per capture, and every wrong one fails the CRC here — running full BP on
  // each (especially on dense grids) would freeze the worker. So during search we
  // reject on the fast path alone; the real per-frame decode (locked spec) keeps BP.
  if (fastOnly) return null

  // SLOW PATH: soft belief-propagation actually corrects the errors. BP time is
  // O(iters × codeword-edges), so a fixed 24 iters made a dense 256² frame take
  // ~1.6 s even in WASM — one such call freezes a decode worker and streaks the
  // receiver's scan rate to 0. Bound the per-call cost instead: budget iters so
  // iters×n is roughly constant. Small grids still get the full 24; a 256² frame
  // gets ~6, which the temporal combiner covers by closing on a later look (usually
  // via the cheap fast path once enough looks stack up). Floor 6 keeps BP useful.
  const iters = Math.max(2, Math.min(maxBpIters, Math.round(1_200_000 / code.n)))
  return check(ldpcDecode(code, cwLlr, iters))
}

/** Pack one frame: [type|seed|len|payload|crc] → LDPC codeword → interleave. */
function packFrame(type: number, seed: number, payload: Uint8Array, capacity: number, rate: number): Uint8Array {
  return packFrameLdpc(type, seed, payload, capacity, rate)
}

export interface ParsedFrame {
  type: number
  seed: number
  payload: Uint8Array
}

/** Split compressed data into K fixed-size, zero-padded chunks. */
export function makeChunks(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const k = Math.max(1, Math.ceil(data.length / chunkSize))
  const chunks: Uint8Array[] = []
  for (let i = 0; i < k; i++) {
    const c = new Uint8Array(chunkSize)
    c.set(data.subarray(i * chunkSize, (i + 1) * chunkSize))
    chunks.push(c)
  }
  return chunks
}

/** XOR the fountain-selected chunks for a seed into one coded chunk. */
export function fountainEncode(chunks: Uint8Array[], seed: number, chunkSize: number, mediumWideEvery = 4): Uint8Array {
  const out = new Uint8Array(chunkSize)
  for (const idx of indicesForSeed(seed, chunks.length, true, mediumWideEvery)) {
    const c = chunks[idx]
    for (let i = 0; i < chunkSize; i++) out[i] ^= c[i]
  }
  return out
}

/**
 * Fountain-encode directly from one packed payload. This avoids creating K
 * zero-padded chunk allocations (and, previously, a second full copy of every
 * encoded frame) before transmission begins.
 */
function fountainEncodePayload(data: Uint8Array, k: number, seed: number, chunkSize: number, mediumWideEvery = 4): Uint8Array {
  const out = new Uint8Array(chunkSize)
  for (const idx of indicesForSeed(seed, k, true, mediumWideEvery)) {
    const start = idx * chunkSize
    const end = Math.min(start + chunkSize, data.length)
    for (let src = start, dst = 0; src < end; src++, dst++) out[dst] ^= data[src]
  }
  return out
}

/**
 * Systematic fountain schedule. The selected direct-source run is followed by one
 * new repair equation. This keeps the fast systematic start, but lets the
 * receiver peel camera losses throughout the transfer instead of leaving all
 * repair work (and the visible speed drop) until the last third.
 */
export function seedForDataIndex(dataIndex: number, k: number, directPerRepair = 8): number {
  // Keep this argument explicit for the codec laboratory. Production uses the
  // proven default cadence unless a measured profile explicitly overrides it.
  directPerRepair = Math.max(1, Math.floor(directPerRepair))
  const span = directPerRepair + 1
  const group = Math.floor(dataIndex / span)
  const slot = dataIndex % span
  const directIndex = group * directPerRepair + slot
  if (slot < directPerRepair && directIndex < k) return directIndex + 1

  // Number of direct chunks emitted before this timeline position. The remaining
  // positions are unique repair seeds, including spare slots in the last group.
  const directBefore = Math.min(k, group * directPerRepair + Math.min(slot, directPerRepair))
  const repairOrdinal = dataIndex - directBefore
  return k + repairOrdinal + 1
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// v5 manifest wire format. It is deliberately compact and has a recognizable
// prefix so updated receivers can still accept the compressed-JSON v1–v4 form.
const MANIFEST_WIRE_MAGIC = [0x47, 0x44, 0x01] as const // "GD", wire format 1
const MANIFEST_WIRE_V6_MAGIC = [0x47, 0x44, 0x02] as const // "GD", compact optical-free form
const ENC_TO_WIRE: Record<Encoding, number> = { bw: 0, color8: 1, color16: 2, color32: 3, color64: 4 }
const WIRE_TO_ENC: Encoding[] = ['bw', 'color8', 'color16', 'color32', 'color64']

function shaToBytes(sha: string | undefined): Uint8Array {
  const out = new Uint8Array(32)
  if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) return out
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(sha.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToSha(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Compact binary form used by v5; avoids JSON keys and repeated text metadata. */
export function encodeManifestWire(m: TransferManifest): Uint8Array {
  const name = textEncoder.encode(m.name)
  const mime = textEncoder.encode(m.mime)
  // v6 leaves optical geometry, colour, rate and zones to the fixed barcode.
  // FPS remains here because CameraReader uses it to avoid decoding duplicate
  // camera captures; it is not part of the barcode.
  if (m.v >= 6) {
    const out = new Uint8Array(61 + name.length + mime.length)
    const view = new DataView(out.buffer)
    out.set(MANIFEST_WIRE_V6_MAGIC, 0)
    let off = 3
    out[off++] = m.v
    view.setUint32(off, m.id, true); off += 4
    out[off++] = (m.kind === 'file' ? 1 : 0) | ((m.compressed ?? true) ? 2 : 0)
    view.setUint16(off, Math.round((m.fps ?? 0) * 10), true); off += 2
    view.setUint32(off, m.total, true); off += 4
    view.setUint32(off, m.comp, true); off += 4
    view.setUint32(off, m.k, true); off += 4
    view.setUint16(off, m.chunk, true); off += 2
    out.set(shaToBytes(m.sha256), off); off += 32
    view.setUint16(off, name.length, true); off += 2
    view.setUint16(off, mime.length, true); off += 2
    out.set(name, off); off += name.length
    out.set(mime, off)
    return out
  }
  const zones = m.zones
  const fixed = 68 + (zones ? 2 : 0)
  const out = new Uint8Array(fixed + name.length + mime.length)
  const view = new DataView(out.buffer)
  out.set(MANIFEST_WIRE_MAGIC, 0)
  let off = 3
  out[off++] = m.v
  view.setUint32(off, m.id, true); off += 4
  out[off++] = (m.kind === 'file' ? 1 : 0) | ((m.compressed ?? true) ? 2 : 0) | (zones ? 4 : 0)
  out[off++] = ENC_TO_WIRE[m.enc]
  view.setUint16(off, m.gridW, true); off += 2
  view.setUint16(off, m.gridH, true); off += 2
  view.setUint16(off, Math.round(m.rate * 1000), true); off += 2
  view.setUint16(off, Math.round((m.fps ?? 0) * 10), true); off += 2
  view.setUint32(off, m.total, true); off += 4
  view.setUint32(off, m.comp, true); off += 4
  view.setUint32(off, m.k, true); off += 4
  view.setUint16(off, m.chunk, true); off += 2
  out.set(shaToBytes(m.sha256), off); off += 32
  if (zones) { out[off++] = zones[0]; out[off++] = zones[1] }
  view.setUint16(off, name.length, true); off += 2
  view.setUint16(off, mime.length, true); off += 2
  out.set(name, off); off += name.length
  out.set(mime, off)
  return out
}

/** Decode a v5 wire manifest. Invalid/truncated input returns null without allocating. */
export function decodeManifestWire(body: Uint8Array, optical?: EncodingSpec): TransferManifest | null {
  if (body.length < 3 || body[0] !== 0x47 || body[1] !== 0x44) return null
  try {
    if (MANIFEST_WIRE_V6_MAGIC.every((byte, i) => body[i] === byte)) {
      if (body.length < 61 || !optical) return null
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
      let off = 3
      const v = body[off++]
      if (v !== 6) return null
      const id = view.getUint32(off, true); off += 4
      const flags = body[off++]!
      const fps10 = view.getUint16(off, true); off += 2
      const total = view.getUint32(off, true); off += 4
      const comp = view.getUint32(off, true); off += 4
      const k = view.getUint32(off, true); off += 4
      const chunk = view.getUint16(off, true); off += 2
      const sha256 = bytesToSha(body.subarray(off, off + 32)); off += 32
      const nameLen = view.getUint16(off, true); off += 2
      const mimeLen = view.getUint16(off, true); off += 2
      if (off + nameLen + mimeLen !== body.length) return null
      const name = textDecoder.decode(body.subarray(off, off + nameLen)); off += nameLen
      const mime = textDecoder.decode(body.subarray(off, off + mimeLen))
      const manifest: TransferManifest = {
        v, id, kind: flags & 1 ? 'file' : 'text', name, mime, total, comp,
        compressed: !!(flags & 2), sha256, k, chunk,
        enc: optical.enc, gridW: optical.gridW, gridH: optical.gridH, rate: optical.rate ?? DEFAULT_RATE,
        ...(fps10 ? { fps: fps10 / 10 } : {}),
      }
      return isValidManifest(manifest) ? manifest : null
    }
    if (body.length < 68 || !MANIFEST_WIRE_MAGIC.every((byte, i) => body[i] === byte)) return null
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    let off = 3
    const v = body[off++]
    if (v !== 5) return null
    const id = view.getUint32(off, true); off += 4
    const flags = body[off++]!
    const enc = WIRE_TO_ENC[body[off++]!]
    if (!enc) return null
    const gridW = view.getUint16(off, true); off += 2
    const gridH = view.getUint16(off, true); off += 2
    const rate = view.getUint16(off, true) / 1000; off += 2
    const fps10 = view.getUint16(off, true); off += 2
    const total = view.getUint32(off, true); off += 4
    const comp = view.getUint32(off, true); off += 4
    const k = view.getUint32(off, true); off += 4
    const chunk = view.getUint16(off, true); off += 2
    const sha256 = bytesToSha(body.subarray(off, off + 32)); off += 32
    const zones: [number, number] | undefined = flags & 4 ? [body[off++]!, body[off++]!] : undefined
    if (off + 4 > body.length) return null
    const nameLen = view.getUint16(off, true); off += 2
    const mimeLen = view.getUint16(off, true); off += 2
    if (off + nameLen + mimeLen !== body.length) return null
    const name = textDecoder.decode(body.subarray(off, off + nameLen)); off += nameLen
    const mime = textDecoder.decode(body.subarray(off, off + mimeLen))
    const manifest: TransferManifest = {
      v, id, kind: flags & 1 ? 'file' : 'text', name, mime, total, comp,
      compressed: !!(flags & 2), sha256, k, chunk, enc, gridW, gridH, rate,
      ...(fps10 ? { fps: fps10 / 10 } : {}),
      ...(zones ? { zones } : {}),
    }
    return isValidManifest(manifest) ? manifest : null
  } catch {
    return null
  }
}

function randomTransferId(): number {
  const out = new Uint32Array(1)
  globalThis.crypto.getRandomValues(out)
  return out[0]!
}

/**
 * Encode a manifest as one or more type-0 frames. v5 uses the compact binary
 * wire form; earlier versions retain compressed JSON for compatibility.
 */
export function encodeManifestFrames(m: TransferManifest, capacity: number, rate: number = m.rate ?? DEFAULT_RATE): Uint8Array[] {
  const body = m.v >= 5 ? encodeManifestWire(m) : compress(textEncoder.encode(JSON.stringify(m)))
  const dataBytes = ldpcMessageBytes(capacity, rate)
  const usable = dataBytes - HEADER_BYTES - CRC_BYTES - MANIFEST_SUBHEADER
  const parts = Math.max(1, Math.ceil(body.length / usable))
  const frames: Uint8Array[] = []
  for (let p = 0; p < parts; p++) {
    const slice = body.subarray(p * usable, (p + 1) * usable)
    const payload = new Uint8Array(MANIFEST_SUBHEADER + slice.length)
    payload[0] = p
    payload[1] = parts
    payload.set(slice, MANIFEST_SUBHEADER)
    frames.push(packFrame(FRAME_TYPE_MANIFEST, 0, payload, capacity, rate))
  }
  return frames
}

/** Reassembles multi-part manifests from type-0 frame payloads. */
export class ManifestAssembler {
  private parts = new Map<number, Uint8Array>()
  private count = 0

  /** Feed a manifest-frame payload; returns the manifest once complete. */
  add(payload: Uint8Array, optical?: EncodingSpec): TransferManifest | null {
    if (payload.length < MANIFEST_SUBHEADER) return null
    const idx = payload[0], total = payload[1]
    if (total < 1) return null
    if (total !== this.count) { this.parts.clear(); this.count = total }
    this.parts.set(idx, payload.slice(MANIFEST_SUBHEADER))
    if (this.parts.size !== this.count) return null
    let len = 0
    for (let i = 0; i < this.count; i++) {
      const part = this.parts.get(i)
      if (!part) return null
      len += part.length
    }
    const body = new Uint8Array(len)
    let off = 0
    for (let i = 0; i < this.count; i++) { const part = this.parts.get(i)!; body.set(part, off); off += part.length }
    try {
      if (body[0] === 0x47 && body[1] === 0x44) return decodeManifestWire(body, optical)
      return JSON.parse(textDecoder.decode(decompress(body))) as TransferManifest
    } catch {
      return null
    }
  }
}

/**
 * Try to pack the whole transfer into ONE self-contained frame. Returns the
 * frame if everything fits (short text, tiny image → a single static matrix,
 * like a QR code — no animation needed), otherwise null.
 * Solo payload: [metaLen u16][meta JSON][compressed data].
 */
export function buildSolo(
  meta: { kind: 'file' | 'text'; name: string; mime: string },
  spec: EncodingSpec,
  packed: PackedPayload,
  sha256: string,
  zm?: ZoneMap,
): Uint8Array | null {
  const capacity = zm ? capacityBytesZoned(zm) : capacityBytes(spec)
  const usable = frameDataBytes(spec, zm) - HEADER_BYTES - CRC_BYTES
  const body = packed.bytes
  const soloMeta: SoloMeta = { ...meta, compressed: packed.compressed, sha256 }
  const metaJson = textEncoder.encode(JSON.stringify(soloMeta))
  const total = 2 + metaJson.length + body.length
  if (total > usable) return null
  const payload = new Uint8Array(total)
  new DataView(payload.buffer).setUint16(0, metaJson.length, true)
  payload.set(metaJson, 2)
  payload.set(body, 2 + metaJson.length)
  return packFrame(FRAME_TYPE_SOLO, 0, payload, capacity, specRate(spec))
}

/** Decode a solo-frame payload back into the original content. */
export async function parseSolo(payload: Uint8Array): Promise<SoloContent | null> {
  try {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const metaLen = dv.getUint16(0, true)
    const meta = JSON.parse(textDecoder.decode(payload.subarray(2, 2 + metaLen))) as SoloMeta
    const bytes = unpackPayload(payload.subarray(2 + metaLen), meta.compressed ?? true)
    if (meta.sha256 && await sha256Hex(bytes) !== meta.sha256) return null
    return { kind: meta.kind, name: meta.name, mime: meta.mime, bytes }
  } catch {
    return null
  }
}

/**
 * Build the complete ordered frame list for one transfer.
 * `raw` is the original file/text bytes; it is compressed here.
 */
export async function buildTransfer(
  raw: Uint8Array,
  meta: { kind: 'file' | 'text'; name: string; mime: string },
  opts: BuildOptions,
): Promise<BuiltTransfer> {
  const zm = opts.zoneMap
  const capacity = zm ? capacityBytesZoned(zm) : capacityBytes(opts.spec)
  const rate = specRate(opts.spec)
  const usable = frameDataBytes(opts.spec, zm) - HEADER_BYTES - CRC_BYTES
  const chunkSize = Math.min(opts.chunkSize, usable)

  const [packed, sha256] = await Promise.all([Promise.resolve(packPayload(raw)), sha256Hex(raw)])

  // A single static frame → whole matrix, no animation (QR-like).
  const solo = buildSolo(meta, opts.spec, packed, sha256, zm)
  if (solo) {
    const manifest: TransferManifest = {
      v: zm ? 5 : 6, id: randomTransferId(),
      kind: meta.kind, name: meta.name, mime: meta.mime,
      total: raw.length, comp: packed.bytes.length, compressed: packed.compressed, sha256,
      k: 1, chunk: packed.bytes.length,
      enc: opts.spec.enc, gridW: opts.spec.gridW, gridH: opts.spec.gridH, rate,
      fps: opts.fps,
      ...(zm && opts.zoneRingWidth ? { zones: serializeZoneMap(opts.zoneRingWidth, zm.zones[0].enc) } : {}),
    }
    return { frameAt: () => solo, frameCount: 1, frames: { length: 1 }, manifest, bootstrapRate: rate, capacity, dataFrameCount: 1, static: true }
  }

  const k = Math.max(1, Math.ceil(packed.bytes.length / chunkSize))

  const manifest: TransferManifest = {
    v: zm ? 5 : 6,
    id: randomTransferId(),
    kind: meta.kind,
    name: meta.name,
    mime: meta.mime,
    total: raw.length,
    comp: packed.bytes.length,
    compressed: packed.compressed,
    sha256,
    k,
    chunk: chunkSize,
    enc: opts.spec.enc,
    gridW: opts.spec.gridW,
    gridH: opts.spec.gridH,
    rate,
    fps: opts.fps,
    ...(zm && opts.zoneRingWidth ? { zones: serializeZoneMap(opts.zoneRingWidth, zm.zones[0].enc) } : {}),
  }

  // v6 manifests intentionally omit optical parameters: the receiver derives
  // them from the fixed barcode. Therefore bootstrap and payload MUST use the
  // same LDPC rate. Sending the manifest at 0.5 and payload at 0.6 let K decode
  // correctly but made every following data frame undecodable (0/K forever).
  const bootstrapRate = rate
  const manifestFrames = encodeManifestFrames(manifest, capacity, bootstrapRate)
  // The receiver can't decode ANYTHING until it has the manifest (K, chunk size,
  // spec). The leading copies provide an immediate lock-on for the normal flow.
  // Afterwards, re-insert only every 96 data frames. The fixed metadata strip
  // already locks the optical settings, while this transfer manifest is needed
  // only once for K/file details. The 16-frame bootstrap below covers normal
  // receiver-first use; a late receiver still waits at most about eight seconds
  // on a single lane (half that in Turbo), and early data are buffered safely.
  const manifestEvery = Math.max(4, opts.manifestEvery ?? 96)
  // MUST emit at least ~K distinct fountain frames or the transfer can never
  // complete (the receiver needs ~K distinct seeds). A larger pool also means
  // fewer repeat captures → faster collection. So always ensure the recommended
  // count regardless of any smaller requested value.
  const dataFrameCount = Math.max(opts.frameCount, recommendedFrameCount(k))

  // Lead with several manifest copies so a late-joining/auto-detecting receiver
  // grabs K and the chunk size within its first captures; then re-insert regularly.
  // A phone needs several stable looks to locate the matrix, calibrate colour
  // anchors, and decode the metadata. A 1.2-second preamble let the valuable
  // first systematic chunks pass before this bootstrap had settled, producing
  // a slow repair tail. Sixteen copies provide ~2.5 seconds at the proven
  // 6.5 FPS profile; that small fixed cost avoids losing a large part of K.
  // Dense BW gets a longer one-time acquisition preamble. Periodic metadata stays
  // a SINGLE frame: a multi-frame burst looked like the sender froze every few
  // seconds and consumed payload time after the receiver already knew K.
  const leadingManifestCount = manifestFrames.length * 10
  const manifestBurst = manifestFrames.length
  // v4 mapping: a medium-wide repair every second repair. It has a materially
  // shorter completion tail at the measured 84–88% frame-validity range.
  const mediumWideEvery = 2
  const fullGroups = Math.floor(dataFrameCount / manifestEvery)
  const remainder = dataFrameCount % manifestEvery
  const frameCount = leadingManifestCount + fullGroups * (manifestEvery + manifestBurst) + remainder
  // A compact LRU removes the former O(file size) frame allocation. It retains a
  // short render window only, while repeated frame cycles remain deterministic.
  const cache = new Map<number, Uint8Array>()
  const CACHE_LIMIT = 24
  const frameAt = (requested: number): Uint8Array => {
    const index = ((requested % frameCount) + frameCount) % frameCount
    const hit = cache.get(index)
    if (hit) return hit
    let frame: Uint8Array
    if (index < leadingManifestCount) {
      frame = manifestFrames[index % manifestFrames.length]!
    } else {
      const pos = index - leadingManifestCount
      const groupSpan = manifestEvery + manifestBurst
      const group = Math.floor(pos / groupSpan)
      const inGroup = pos % groupSpan
      if (group < fullGroups && inGroup >= manifestEvery) {
        frame = manifestFrames[(inGroup - manifestEvery) % manifestFrames.length]!
      } else {
        const dataIndex = group * manifestEvery + inGroup
        const seed = seedForDataIndex(dataIndex, k, opts.systematicRun ?? 8)
        frame = packFrame(FRAME_TYPE_DATA, seed, fountainEncodePayload(packed.bytes, k, seed, chunkSize, mediumWideEvery), capacity, rate)
      }
    }
    cache.set(index, frame)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as number)
    return frame
  }

  return { frameAt, frameCount, frames: { length: frameCount }, manifest, bootstrapRate, capacity, dataFrameCount, static: false }
}

/**
 * Distinct fountain frames to emit for K chunks. A pool ~2× K means most
 * captures are new (few repeats → faster), while staying bounded in memory.
 */
export function recommendedFrameCount(k: number): number {
  return Math.min(8000, Math.max(k + 30, Math.ceil(k * 2)))
}

/**
 * Turn a completed fountain reconstruction (k*chunk bytes) back into the
 * original file/text bytes: trim padding to the compressed length, inflate.
 */
export async function finishTransfer(reconstructed: Uint8Array, manifest: TransferManifest): Promise<Uint8Array> {
  const comp = reconstructed.subarray(0, manifest.comp)
  const bytes = unpackPayload(comp, manifest.compressed ?? true)
  if (manifest.sha256 && await sha256Hex(bytes) !== manifest.sha256)
    throw new Error('SHA-256 verification failed')
  return bytes
}
