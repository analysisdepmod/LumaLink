// CRC-32 (IEEE 802.3) with a precomputed table. Used to validate each
// decoded frame before feeding it to the fountain decoder, so camera
// noise never corrupts the reconstructed data.

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
