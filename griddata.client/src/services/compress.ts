import { deflate, inflate } from 'pako'

export interface PackedPayload {
  bytes: Uint8Array
  compressed: boolean
}

/** Compress only when it reduces the wire payload. */
export function packPayload(data: Uint8Array): PackedPayload {
  const compressed = deflate(data)
  return compressed.length < data.length
    ? { bytes: compressed, compressed: true }
    : { bytes: data, compressed: false }
}

export function unpackPayload(data: Uint8Array, compressed = true): Uint8Array {
  if (!compressed) return data.slice()
  return inflate(data)
}

/**
 * Inflate larger completed transfers through the browser's streaming codec
 * when available. This yields back to the UI and avoids making a completed
 * receiver look as if it is still decoding camera frames.
 */
export async function unpackPayloadAsync(data: Uint8Array, compressed = true): Promise<Uint8Array> {
  if (!compressed) return data.slice()
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const source = new Blob([Uint8Array.from(data)]).stream()
      const output = source.pipeThrough(new DecompressionStream('deflate'))
      return new Uint8Array(await new Response(output).arrayBuffer())
    } catch {
      // Older WebViews may expose DecompressionStream without deflate support.
    }
  }
  return inflate(data)
}

/** Used by the compact manifest envelope, which is always compressed. */
export function compress(data: Uint8Array): Uint8Array { return deflate(data) }
export function decompress(data: Uint8Array): Uint8Array { return inflate(data) }

export async function sha256Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}
