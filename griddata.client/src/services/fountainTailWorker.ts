/// <reference lib="webworker" />
import { solveDenseTail, type DenseTailRow } from './fountainTailSolve'

interface TailSolveRequest { rows: DenseTailRow[]; missing: number }

self.onmessage = (event: MessageEvent<TailSolveRequest>) => {
  // This is already a dedicated worker: yielding through setTimeout does not
  // protect the camera/UI thread. In real browsers those timers can be heavily
  // clamped, stretching a ~50 ms elimination across several optical seconds.
  const started = performance.now()
  const values = solveDenseTail(event.data.rows, event.data.missing)
  const ms = performance.now() - started
  const transfer = values?.map(value => value.data.buffer) ?? []
  self.postMessage({ values, ms }, { transfer })
}

export {}
