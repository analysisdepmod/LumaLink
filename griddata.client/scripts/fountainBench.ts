import { FountainDecoder } from '../src/services/fountainDecoder.ts'
import { seedForDataIndex } from '../src/services/transferCodec.ts'

interface Scenario {
  name: string
  senderFps: number
  captureFps: number
  validRate: number
  pairedBurstEvery: number
}

class Random {
  constructor(private state: number) {}
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const scenarios: Scenario[] = [
  { name: 'field-fast', senderFps: 12, captureFps: 11.67, validRate: 0.905, pairedBurstEvery: 0 },
  { name: 'field-loaded', senderFps: 12, captureFps: 10.39, validRate: 0.881, pairedBurstEvery: 0 },
  { name: 'paired-bursts', senderFps: 12, captureFps: 10.8, validRate: 0.90, pairedBurstEvery: 23 },
]

function trial(scenario: Scenario, directRun: number, wideEvery: number, trialNo: number): number {
  const k = 461
  const decoder = new FountainDecoder(k, 1, true, wideEvery)
  const random = new Random(0x9e3779b9 ^ (trialNo * 0x45d9f3b))
  let captures = 0
  let replies = 0
  let lastSenderTick = -1
  while (!decoder.isComplete && captures < 1400) {
    const senderTick = Math.floor(captures * scenario.senderFps / scenario.captureFps)
    captures++
    if (senderTick === lastSenderTick) continue
    lastSenderTick = senderTick
    const burstLost = scenario.pairedBurstEvery > 0 && senderTick % scenario.pairedBurstEvery === scenario.pairedBurstEvery - 1
    for (const dataIndex of [senderTick * 2, senderTick * 2 + 1]) {
      replies++
      if (!burstLost && random.next() < scenario.validRate) {
        decoder.addFrame(seedForDataIndex(dataIndex, k, directRun), new Uint8Array(1))
      }
    }
  }
  return decoder.isComplete ? replies : Number.POSITIVE_INFINITY
}

for (const scenario of scenarios) {
  const rows: { schedule: string; average: number; p90: number; failed: number }[] = []
  for (const directRun of [4, 5, 6, 7, 8, 10]) for (const wideEvery of [1, 2, 3, 4]) {
    const values = Array.from({ length: 24 }, (_, trialNo) => trial(scenario, directRun, wideEvery, trialNo))
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b)
    rows.push({
      schedule: `${directRun}:1 / w${wideEvery}`,
      average: finite.length ? Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length) : Infinity,
      p90: finite.length ? finite[Math.floor((finite.length - 1) * 0.9)] : Infinity,
      failed: values.length - finite.length,
    })
  }
  console.log(`\n${scenario.name}`)
  console.table(rows.sort((a, b) => a.failed - b.failed || a.average - b.average).slice(0, 8))
}
