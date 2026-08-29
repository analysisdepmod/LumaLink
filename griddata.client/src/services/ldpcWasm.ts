// Browser loader for the optimized LDPC WebAssembly binary.

import wasmUrl from './ldpcbp.wasm?url'
import { instantiateLdpcWasm, type WasmDecoder } from './ldpcWasmCore'

export type { WasmDecoder } from './ldpcWasmCore'

export async function loadLdpcWasm(): Promise<WasmDecoder | null> {
  try {
    const response = await fetch(wasmUrl)
    return await instantiateLdpcWasm(await response.arrayBuffer())
  } catch {
    return null
  }
}
