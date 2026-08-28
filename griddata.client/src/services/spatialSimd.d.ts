declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  /**
   * assembly/spatialSimd/init
   * @param n `i32`
   */
  export function init(n: number): void;
  /**
   * assembly/spatialSimd/pObserved
   * @returns `usize`
   */
  export function pObserved(): number;
  /**
   * assembly/spatialSimd/pInput
   * @returns `usize`
   */
  export function pInput(): number;
  /**
   * assembly/spatialSimd/pOutput
   * @returns `usize`
   */
  export function pOutput(): number;
  /**
   * assembly/spatialSimd/unsharp
   * @param w `i32`
   * @param h `i32`
   * @param from `i32`
   * @param strength `f32`
   * @param lo `f32`
   * @param hi `f32`
   */
  export function unsharp(w: number, h: number, from: number, strength: number, lo: number, hi: number): void;
  /**
   * assembly/spatialSimd/deconvolve
   * @param w `i32`
   * @param h `i32`
   * @param from `i32`
   * @param spill `f32`
   * @param lo `f32`
   * @param hi `f32`
   * @param iters `i32`
   */
  export function deconvolve(w: number, h: number, from: number, spill: number, lo: number, hi: number, iters: number): void;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
  env: unknown,
}): Promise<typeof __AdaptedExports>;
