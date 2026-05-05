import type { Priority } from '../types'

export interface QueuedMessage {
  requestId: string
  priority: Priority
  audioBuffer: AudioBuffer
  text: string
  enqueuedAt: number
}

const MAX_INFO_ITEMS = 10
const MAX_AUDIO_DURATION_MS = 15_000

export class PriorityQueue {
  private items: QueuedMessage[] = []

  /**
   * Returns false if item was rejected (too long or queue overflow).
   */
  enqueue(item: QueuedMessage): boolean {
    const durationMs = Math.round(item.audioBuffer.duration * 1000)
    if (durationMs > MAX_AUDIO_DURATION_MS) {
      console.warn(`[RaceEngineer] Audio dropped: duration ${durationMs}ms exceeds max ${MAX_AUDIO_DURATION_MS}ms (text: "${item.text}")`)
      return false
    }

    if (item.priority === 'critical') {
      this.items.unshift(item)
    } else if (item.priority === 'high') {
      const lastCritIdx = this.items.reduce(
        (acc, it, idx) => (it.priority === 'critical' ? idx : acc),
        -1,
      )
      this.items.splice(lastCritIdx + 1, 0, item)
    } else {
      // info: FIFO, drop oldest info if over cap
      const infoCount = this.items.filter(i => i.priority === 'info').length
      if (infoCount >= MAX_INFO_ITEMS) {
        const oldestIdx = this.items.findIndex(i => i.priority === 'info')
        if (oldestIdx !== -1) this.items.splice(oldestIdx, 1)
      }
      this.items.push(item)
    }

    return true
  }

  dequeue(): QueuedMessage | undefined {
    return this.items.shift()
  }

  get length(): number {
    return this.items.length
  }

  clear() {
    this.items = []
  }
}
