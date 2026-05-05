export type RadioEffectMode = 'off' | 'subtle' | 'medium' | 'strong'

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 44100
  const curve = new Float32Array(samples)
  const deg = Math.PI / 180
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x))
  }
  return curve
}

function synthPttClick(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 0.01) // 10ms
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const env = 1 - i / len
    data[i] = (Math.random() * 2 - 1) * env * 0.6
  }
  return buf
}

export interface EffectChainResult {
  noiseSources: AudioBufferSourceNode[]
  pttBuffers: AudioBuffer[] // [before, after] — only for 'strong'
}

/**
 * Connects `source` through the chosen effect chain to `gainNode`.
 * Caller is responsible for starting `source` and stopping `noiseSources`.
 */
export function connectWithEffect(
  ctx: AudioContext,
  source: AudioBufferSourceNode,
  gainNode: GainNode,
  mode: RadioEffectMode,
  noiseBuffer: AudioBuffer | null,
): EffectChainResult {
  if (mode === 'off') {
    source.connect(gainNode)
    return { noiseSources: [], pttBuffers: [] }
  }

  if (mode === 'subtle') {
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1500
    bp.Q.value = 0.7

    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.ratio.value = 3
    comp.attack.value = 0.003
    comp.release.value = 0.1

    source.connect(bp).connect(comp).connect(gainNode)
    return { noiseSources: [], pttBuffers: [] }
  }

  if (mode === 'medium') {
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 300

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3400

    const shaper = ctx.createWaveShaper()
    shaper.curve = makeDistortionCurve(5)
    shaper.oversample = '4x'

    source.connect(hp).connect(lp).connect(shaper).connect(gainNode)

    const noiseSources: AudioBufferSourceNode[] = []
    if (noiseBuffer) {
      const noiseGain = ctx.createGain()
      noiseGain.gain.value = 0.006 // ~−44 dB
      const noise = ctx.createBufferSource()
      noise.buffer = noiseBuffer
      noise.loop = true
      noise.connect(noiseGain).connect(gainNode)
      noise.start()
      noiseSources.push(noise)
    }

    return { noiseSources, pttBuffers: [] }
  }

  // strong
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 400

  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3000

  const shaper = ctx.createWaveShaper()
  shaper.curve = makeDistortionCurve(20)
  shaper.oversample = '4x'

  source.connect(hp).connect(lp).connect(shaper).connect(gainNode)

  const noiseSources: AudioBufferSourceNode[] = []
  if (noiseBuffer) {
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.022 // ~−33 dB
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuffer
    noise.loop = true
    noise.connect(noiseGain).connect(gainNode)
    noise.start()
    noiseSources.push(noise)
  }

  const click = synthPttClick(ctx)
  return { noiseSources, pttBuffers: [click, click] }
}
