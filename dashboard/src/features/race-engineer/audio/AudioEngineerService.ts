import { decode } from '@msgpack/msgpack'
import { useSettingsStore } from '../../../stores/settingsStore'
import type { EngineerCommand, EngineerMessage } from '../types'
import { connectWithEffect, type RadioEffectMode } from './radioEffect'
import { PriorityQueue } from './priorityQueue'
import { wavBase64ToAudioBuffer } from './wavDecoder'

type MessageHandler = (msg: EngineerMessage) => void

class AudioEngineerService {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private running = false

  private audioCtx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null

  private enabled = false
  private volume = 0.7
  private radioEffect: RadioEffectMode = 'subtle'
  private outputDeviceId: string | null = null
  private audioOnThisDevice = true

  private cachedBehavior = {
    enabled: false,
    frequency: 'medium' as 'low' | 'medium' | 'high',
    muteInQualifying: false,
    debugAllRulesInPractice: false,
    activeVoiceId: null as string | null,
    pilotName: '',
    muteNameInCallouts: false,
  }

  private queue = new PriorityQueue()
  private playing = false
  private playbackId = 0
  private currentSource: AudioBufferSourceNode | null = null
  private currentNoiseSources: AudioBufferSourceNode[] = []
  private interruptTimer: ReturnType<typeof setTimeout> | null = null

  private handlers = new Set<MessageHandler>()

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init() {
    if (this.running) return
    this.running = true
    this.connect()
  }

  destroy() {
    this.running = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private getWsUrl(): string {
    const { wsHost, wsPort } = useSettingsStore.getState()
    const host = (wsHost || '').trim() || window.location.hostname
    return `ws://${host}:${wsPort}`
  }

  private connect() {
    if (!this.running) return
    const ws = new WebSocket(this.getWsUrl())
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.reconnectAttempt = 0
      // Register audio role immediately — must come before any other command.
      ws.send(JSON.stringify({
        command: 'engineer_register_client_role',
        role: this.audioOnThisDevice ? 'audio' : 'display_only',
      }))
      // Re-sync behavior state with bridge after (re)connect.
      this.sendCurrentBehavior()
      if (this.handlers.size > 0) {
        ws.send(JSON.stringify({ command: 'engineer_get_status' }))
      }
    }

    ws.onmessage = (event) => {
      try {
        let msg: EngineerMessage
        if (event.data instanceof ArrayBuffer) {
          msg = decode(new Uint8Array(event.data)) as EngineerMessage
        } else {
          msg = JSON.parse(event.data as string) as EngineerMessage
        }
        void this.handleMessage(msg)
      } catch { /* malformed frame — ignore */ }
    }

    ws.onclose = () => {
      if (!this.running) return
      this.ws = null
      this.reconnectAttempt++
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30000)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
  }

  send(cmd: EngineerCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

  addMessageHandler(handler: MessageHandler) { this.handlers.add(handler) }
  removeMessageHandler(handler: MessageHandler) { this.handlers.delete(handler) }

  // ── Message handling ───────────────────────────────────────────────────────

  private async handleMessage(msg: EngineerMessage) {
    for (const h of this.handlers) h(msg)

    if (msg.type !== 'EngineerAudio' || !this.enabled) return

    try {
      const ctx = this.ensureAudioContext()
      const buffer = await wavBase64ToAudioBuffer(msg.wav_base64, ctx)
      const enqueued = this.queue.enqueue({
        requestId: msg.request_id,
        priority: msg.priority,
        audioBuffer: buffer,
        text: msg.text,
        enqueuedAt: Date.now(),
      })
      if (!enqueued) return

      if (!this.playing) {
        this.playNext()
      } else if (msg.priority === 'critical') {
        this.interruptAndPlay()
      }
    } catch (e) {
      console.error('[RaceEngineer] Audio decode error:', e)
    }
  }

  // ── AudioContext ───────────────────────────────────────────────────────────

  private ensureAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext()

      this.gainNode = this.audioCtx.createGain()
      this.gainNode.gain.value = this.volume
      this.gainNode.connect(this.audioCtx.destination)

      // 2s white noise buffer for medium/strong effects
      const sr = this.audioCtx.sampleRate
      const buf = this.audioCtx.createBuffer(1, sr * 2, sr)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      this.noiseBuffer = buf

      if (this.outputDeviceId) this.applySinkId(this.outputDeviceId)
    }
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume()
    return this.audioCtx
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  private interruptAndPlay() {
    if (this.interruptTimer) clearTimeout(this.interruptTimer)

    const ctx = this.audioCtx
    const gain = this.gainNode
    if (ctx && gain) {
      gain.gain.cancelScheduledValues(ctx.currentTime)
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime)
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05)
    }

    if (this.currentSource) {
      try { this.currentSource.stop(ctx ? ctx.currentTime + 0.05 : 0) } catch { /* AudioNode already stopped */ }
      this.currentSource = null
    }
    for (const ns of this.currentNoiseSources) {
      try { ns.stop(ctx ? ctx.currentTime + 0.05 : 0) } catch { /* AudioNode already stopped */ }
    }
    this.currentNoiseSources = []

    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null
      if (this.gainNode && this.audioCtx) {
        this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime)
        this.gainNode.gain.setValueAtTime(this.volume, this.audioCtx.currentTime)
      }
      this.playing = false
      this.playNext()
    }, 60)
  }

  private playNext() {
    const item = this.queue.dequeue()
    if (!item) {
      this.playing = false
      this.currentSource = null
      return
    }

    this.playing = true
    const myId = ++this.playbackId
    const ctx = this.ensureAudioContext()
    const gain = this.gainNode!

    const source = ctx.createBufferSource()
    source.buffer = item.audioBuffer
    this.currentSource = source

    const { noiseSources, pttBuffers } = connectWithEffect(
      ctx, source, gain, this.radioEffect, this.noiseBuffer,
    )
    this.currentNoiseSources = noiseSources

    const cleanup = () => {
      if (this.playbackId !== myId) return
      for (const ns of noiseSources) try { ns.stop() } catch { /* AudioNode already stopped */ }
      this.currentNoiseSources = []
      this.playNext()
    }

    if (pttBuffers.length >= 2) {
      // PTT click before → speech → PTT click after (strong mode)
      const clickBefore = ctx.createBufferSource()
      clickBefore.buffer = pttBuffers[0]
      clickBefore.connect(gain)
      clickBefore.start()

      const speechStart = ctx.currentTime + 0.05
      source.start(speechStart)
      source.onended = () => {
        if (this.playbackId !== myId) return
        for (const ns of noiseSources) try { ns.stop() } catch { /* AudioNode already stopped */ }
        this.currentNoiseSources = []

        const clickAfter = ctx.createBufferSource()
        clickAfter.buffer = pttBuffers[1]
        clickAfter.connect(gain)
        clickAfter.start()
        clickAfter.onended = cleanup
      }
    } else {
      source.start()
      source.onended = cleanup
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  sendBehaviorUpdate(params: { enabled: boolean; frequency: 'low' | 'medium' | 'high'; muteInQualifying: boolean; debugAllRulesInPractice: boolean; activeVoiceId?: string | null; pilotName?: string; muteNameInCallouts?: boolean }) {
    this.cachedBehavior = {
      ...params,
      activeVoiceId: params.activeVoiceId ?? null,
      pilotName: params.pilotName ?? '',
      muteNameInCallouts: params.muteNameInCallouts ?? false,
    }
    this.sendCurrentBehavior()
  }

  private sendCurrentBehavior() {
    this.send({
      command: 'engineer_update_behavior',
      enabled: this.cachedBehavior.enabled,
      frequency: this.cachedBehavior.frequency,
      mute_in_qualifying: this.cachedBehavior.muteInQualifying,
      debug_all_rules_in_practice: this.cachedBehavior.debugAllRulesInPractice,
      active_voice_id: this.cachedBehavior.activeVoiceId ?? null,
      pilot_name: this.cachedBehavior.pilotName || null,
      mute_name: this.cachedBehavior.muteNameInCallouts,
    })
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) {
      this.queue.clear()
      if (this.currentSource) try { this.currentSource.stop() } catch { /* AudioNode already stopped */ }
      this.currentSource = null
      this.currentNoiseSources = []
      this.playing = false
    }
  }

  setVolume(volume: number) {
    this.volume = volume
    if (this.gainNode) this.gainNode.gain.value = volume
  }

  setRadioEffect(effect: RadioEffectMode) {
    this.radioEffect = effect
  }

  setOutputDevice(deviceId: string | null) {
    this.outputDeviceId = deviceId
    if (this.audioCtx) this.applySinkId(deviceId)
  }

  setAudioOnThisDevice(audioOnThisDevice: boolean) {
    this.audioOnThisDevice = audioOnThisDevice
    this.send({
      command: 'engineer_register_client_role',
      role: audioOnThisDevice ? 'audio' : 'display_only',
    })
  }

  private applySinkId(deviceId: string | null) {
    if (!this.audioCtx) return
    const ctx = this.audioCtx as unknown as { setSinkId?: (id: string) => Promise<void> }
    if (typeof ctx.setSinkId !== 'function') return
    const id = deviceId ?? ''
    ctx.setSinkId(id).catch(() => {
      // Device not found (e.g. unplugged or ID changed) — fall back to default output
      console.warn('[RaceEngineer] setSinkId failed for device, falling back to default output')
      ctx.setSinkId!('').catch(() => { /* ignore */ })
    })
  }
}

export const engineerService = new AudioEngineerService()
