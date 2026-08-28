declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  /**
   * assembly/ldpcbp/init
   * @param n `i32`
   * @param m `i32`
   * @param e `i32`
   */
  export function init(n: number, m: number, e: number): void;
  /**
   * assembly/ldpcbp/pCheckStart
   * @returns `usize`
   */
  export function pCheckStart(): number;
  /**
   * assembly/ldpcbp/pEdgeVar
   * @returns `usize`
   */
  export function pEdgeVar(): number;
  /**
   * assembly/ldpcbp/pVarStart
   * @returns `usize`
   */
  export function pVarStart(): number;
  /**
   * assembly/ldpcbp/pVarEdge
   * @returns `usize`
   */
  export function pVarEdge(): number;
  /**
   * assembly/ldpcbp/pLlr
   * @returns `usize`
   */
  export function pLlr(): number;
  /**
   * assembly/ldpcbp/pHard
   * @returns `usize`
   */
  export function pHard(): number;
  /**
   * assembly/ldpcbp/decode
   * @param iters `i32`
   */
  export function decode(iters: number): void;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
  env: unknown,
}): Promise<typeof __AdaptedExports>;
