/// <reference lib="webworker" />
import { solveDenseTailYielding, type DenseTailRow } from './fountainTailSolve'

interface TailSolveRequest { rows: DenseTailRow[]; missing: number }

self.onmessage = async (event: MessageEvent<TailSolveRequest>) => {
  const yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0))
  const values = await solveDenseTailYielding(event.data.rows, event.data.missing, yieldControl)
  const transfer = values?.map(value => value.data.buffer) ?? []
  self.postMessage({ values }, { transfer })
}

export {}
