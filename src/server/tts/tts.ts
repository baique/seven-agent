import { Communicate } from 'edge-tts-universal'
import { logger } from '../utils/logger'
import { cleanTextForTTS } from '../utils'

export interface TTSServiceOptions {
  voice?: string
  rate?: string
  volume?: string
}

export interface TTSResult {
  audioBuffer: Buffer
  duration: number
}

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
const DEFAULT_RATE = '+30%'
const DEFAULT_VOLUME = '+0%'

const SPEED_MAP: Record<string, string> = {
  stand: '+0%',
  standard: '+0%',
  normal: '+0%',
  slow: '-20%',
  fast: '+20%',
}

function normalizeRate(rate?: string): string {
  if (!rate) return DEFAULT_RATE
  if (SPEED_MAP[rate.toLowerCase()]) {
    return SPEED_MAP[rate.toLowerCase()]
  }
  if (/^[+-]?\d+%$/.test(rate)) {
    return rate
  }
  return DEFAULT_RATE
}

export class EdgeTTSService {
  private voice: string
  private volume: string

  constructor(options: TTSServiceOptions = {}) {
    this.voice = options.voice || DEFAULT_VOICE
    this.volume = options.volume || DEFAULT_VOLUME
  }

  async synthesize(
    text: string,
    rate?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
  ): Promise<TTSResult> {
    try {
      const cleanedText = cleanTextForTTS(text)

      if (!cleanedText) {
        logger.warn('Text is empty after cleaning, skipping TTS')
        return { audioBuffer: Buffer.alloc(0), duration: 0 }
      }

      logger.debug({ text: cleanedText.slice(0, 50), rate }, '[TTS] 开始合成语音')

      const communicate = new Communicate(cleanedText, {
        voice: this.voice,
        rate: normalizeRate(rate),
        volume: this.volume,
      })

      const chunks: Buffer[] = []
      let totalDuration = 0
      let chunkCount = 0

      for await (const chunk of communicate.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          callback?.audio(chunk.data)
          chunks.push(chunk.data)
          chunkCount++

          if (chunkCount % 5 === 0) {
            await new Promise((resolve) => setImmediate(resolve))
          }
        } else if (
          (chunk.type === 'WordBoundary' || chunk.type === 'SentenceBoundary') &&
          chunk.duration
        ) {
          const durationMs = chunk.duration / 10000
          totalDuration += durationMs
        }
      }

      logger.debug({ duration: Math.round(totalDuration), chunkCount }, '[TTS] 语音合成完成')

      return {
        audioBuffer: Buffer.concat(chunks),
        duration: Math.round(totalDuration),
      }
    } catch (error: any) {
      logger.error(
        { error: error?.message || error, stack: error?.stack },
        'Edge TTS synthesis failed',
      )
      throw error
    }
  }
}

let ttsService: EdgeTTSService | null = null

export function getTTSService(): EdgeTTSService {
  if (!ttsService) {
    ttsService = new EdgeTTSService()
  }
  return ttsService
}

export function initTTSService(options?: TTSServiceOptions): void {
  ttsService = new EdgeTTSService(options)
}
