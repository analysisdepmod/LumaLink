/**
 * A local, post-transfer assessment of the real optical link.  It deliberately
 * uses only measurements already produced by the receiver; no feedback channel
 * and no transferred data leave the device.
 */
export interface OpticalCalibrationInput {
  goodputKBs: number
  validFrameRate: number
  averageDecodeMs: number
  chunkBytes: number
  ldpcRate?: number
  senderFps: number | null | undefined
  /** Number of independent optical lanes carrying disjoint fountain frames. */
  lanes?: number
  /** Mean optical reliability measured while sampling the colour cells. */
  colorConfidence?: number
}

export interface OpticalCalibration {
  status: 'clean' | 'stable' | 'strained'
  utilization: number
  label: string
  recommendation: string
}

export function assessOpticalLink(input: OpticalCalibrationInput): OpticalCalibration {
  const laneCount = Math.max(1, input.lanes ?? 1)
  const turboProfile = `Turbo ×${laneCount} Color8 64×64 @ ${input.senderFps ?? 5.5}fps`
  const rate = input.ldpcRate ?? 0.625
  const theoreticalKBs = input.senderFps && input.senderFps > 0
    ? input.chunkBytes * input.senderFps * laneCount / 1024
    : 0
  // The raw optical ceiling includes captures that the measured channel says
  // cannot decode, plus bounded Fountain rank overhead. Judge
  // utilization against the attainable useful ceiling, otherwise a genuinely
  // fast 10.36KB/s run is mislabeled strained merely because 12fps ×2 is the
  // impossible, zero-loss/no-repair limit.
  const usefulFrameFraction = Math.max(0.05, Math.min(1, input.validFrameRate))
  const fountainPayloadFraction = 0.9
  const attainableKBs = theoreticalKBs * usefulFrameFraction * fountainPayloadFraction
  const utilization = attainableKBs > 0
    ? Math.max(0, Math.min(1, input.goodputKBs / attainableKBs))
    : 0
  const colorReady = (input.colorConfidence ?? 0) >= 0.84 && input.validFrameRate >= 0.88 && input.averageDecodeMs <= 190

  // Turbo has a different physical ceiling from a single tile. Return an
  // accurate recommendation rather than the older, hard-coded single-lane text.
  if (laneCount > 1) {
    if (input.validFrameRate >= 0.85 && input.averageDecodeMs <= 240 && utilization >= 0.7) {
      return { status: 'clean', utilization, label: 'وصلة نظيفة', recommendation: colorReady ? `الوصلة نظيفة: حافظ على ${turboProfile} و LDPC ${rate}. لا تنتقل إلى Color16 على هذا المسار قبل اختبار مستقل.` : `حافظ على ${turboProfile} و LDPC ${rate}.` }
    }
    if (input.validFrameRate >= 0.75 && input.averageDecodeMs <= 360 && utilization >= 0.5) {
      return { status: 'stable', utilization, label: 'وصلة مستقرة', recommendation: `الإعداد الحالي هو الاختيار العملي: ${turboProfile} و LDPC ${rate}.` }
    }
    return { status: 'strained', utilization, label: 'الوصلة تحت ضغط', recommendation: `للنقل المهم خفّض ${turboProfile} إلى 5fps و LDPC 0.6.` }
  }

  // This is intentionally conservative. A high instantaneous burst is useful,
  // but a configuration is only called clean when it also sustains valid frames
  // and quick camera decoding over the whole transfer.
  if (input.validFrameRate >= 0.85 && input.averageDecodeMs <= 240 && utilization >= 0.7) {
    return {
      status: 'clean', utilization,
      label: 'وصلة نظيفة',
      recommendation: colorReady
        ? 'حافظ على Color8 64×64 و 6.5fps و LDPC 0.625. ثقة اللون ممتازة؛ يمكنك تجربة Color16 في النقل التالي.'
        : 'حافظ على Color8 64×64 و 6.5fps و LDPC 0.625. لا ترفع الشبكة أو الألوان قبل أن ترتفع ثقة اللون.',
    }
  }
  if (input.validFrameRate >= 0.75 && input.averageDecodeMs <= 360 && utilization >= 0.5) {
    return {
      status: 'stable', utilization,
      label: 'وصلة مستقرة',
      recommendation: 'الإعداد الحالي هو الاختيار العملي. حافظ على Color8 64×64 و 6.5fps؛ زيادة الكثافة الآن قد تخفض السرعة الكلية.',
    }
  }
  return {
    status: 'strained', utilization,
    label: 'الوصلة تحت ضغط',
    recommendation: 'للنقل التالي المهم، استخدم Color8 64×64 مع 6fps و LDPC 0.6، وثبّت الكاميرا واملأ الشاشة بالمصفوفة.',
  }
}
