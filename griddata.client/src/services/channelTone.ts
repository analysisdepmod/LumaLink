/** Tiny optional UI tones generated locally — no media asset or network request. */
type Tone = 'launch' | 'lock' | 'complete'

export function playChannelTone(kind: Tone, enabled: boolean) {
  if (!enabled) return
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const now = ctx.currentTime
    const pattern: Record<Tone, [number, number, number]> = {
      launch: [280, 660, .14], lock: [520, 880, .11], complete: [440, 1040, .24],
    }
    const [from, to, duration] = pattern[kind]
    osc.type = kind === 'complete' ? 'sine' : 'triangle'
    osc.frequency.setValueAtTime(from, now)
    osc.frequency.exponentialRampToValueAtTime(to, now + duration)
    gain.gain.setValueAtTime(.0001, now)
    gain.gain.exponentialRampToValueAtTime(.05, now + .015)
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now); osc.stop(now + duration + .03)
    window.setTimeout(() => void ctx.close(), (duration + .1) * 1000)
  } catch { /* Audio is an optional enhancement; never block transfer UI. */ }
}
