import { request } from 'https'
import { logger, cleanTextForTTS } from '../utils'
import { env } from '../config/env'
import type { TTSResult } from './tts'
import type { BatchContext } from './index'

const SPEED_MAP: Record<string, number> = {
  stand: 1.0,
  standard: 1.0,
  normal: 1.0,
  slow: 0.8,
  fast: 1.2,
}

function normalizeSpeed(speed?: string): number {
  return SPEED_MAP[speed?.toLowerCase() || 'stand'] || 1.0
}

interface MiniMaxBaseResponse {
  status_code: number
  status_msg: string
}

interface MiniMaxStreamResponse {
  base_resp: MiniMaxBaseResponse
  stream_type?: number
  data?: {
    audio_bytes: string
    extra_info?: {
      duration?: number
    }
  }
}

export class MiniMaxTTSService {
  private apiKey: string
  private groupId: string
  private model: string
  private voice: string
  private baseUrl: string

  constructor() {
    this.apiKey = env.MINIMAX_TTS_API_KEY || ''
    this.groupId = env.MINIMAX_TTS_GROUP_ID || ''
    this.model = env.MINIMAX_TTS_MODEL || 'speech-02-turbo'
    this.voice = env.MINIMAX_TTS_VOICE || 'maincommon'
    this.baseUrl = env.MINIMAX_TTS_BASE_URL || 'https://api.minimaxi.com'
  }

  async synthesize(
    text: string,
    speed?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
    _batchContext?: BatchContext,
  ): Promise<TTSResult> {
    const cleanedText = cleanTextForTTS(text)

    if (!cleanedText) {
      return { audioBuffer: Buffer.alloc(0), duration: 0 }
    }

    if (!this.apiKey) {
      throw new Error('MINIMAX_TTS_API_KEY is not configured')
    }

    const speedFactor = normalizeSpeed(speed)
    const chunks: Buffer[] = []
    let totalDuration = 0

    await this.streamSynthesize(cleanedText, speedFactor, (chunk) => {
      if (chunk.type === 'audio' && chunk.data) {
        chunks.push(chunk.data)
        callback?.audio(chunk.data)
      } else if (chunk.type === 'meta' && chunk.duration) {
        totalDuration = chunk.duration
      }
    })

    const audioBuffer = Buffer.concat(chunks)
    const duration = totalDuration || Math.round((audioBuffer.length / 24000) * 1000)

    logger.debug({ bufferLength: audioBuffer.length, duration }, 'MiniMax TTS success')

    return { audioBuffer, duration }
  }

  private async streamSynthesize(
    text: string,
    speed: number,
    onChunk: (chunk: { type: 'audio' | 'meta'; data?: Buffer; duration?: number }) => void,
  ): Promise<void> {
    const groupId = this.groupId || this.apiKey.split('-')[0] || ''

    const payload = {
      model: this.model,
      text,
      voice_setting: {
        voice_id: this.voice,
        speed,
        volume: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 24000,
        bitrate: 128000,
        format: 'mp3',
      },
    }

    return new Promise((resolve, reject) => {
      const hostname = new URL(this.baseUrl).hostname
      const options = {
        hostname,
        port: 443,
        path: `/v1/t2a_v1?GroupId=${groupId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
      }

      const req = request(options, (res) => {
        let buffer = Buffer.alloc(0)

        res.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk])

          let lineEnd = 0
          while ((lineEnd = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, lineEnd).toString('utf-8').trim()
            buffer = buffer.slice(lineEnd + 1)

            if (!line) continue

            try {
              const resp: MiniMaxStreamResponse = JSON.parse(line)

              if (resp.base_resp.status_code !== 0) {
                logger.error({ response: resp }, 'MiniMax TTS stream error')
                reject(new Error(`MiniMax TTS error: ${resp.base_resp.status_msg}`))
                return
              }

              if (resp.stream_type === 1 && resp.data?.audio_bytes) {
                const audioData = Buffer.from(resp.data.audio_bytes, 'base64')
                onChunk({ type: 'audio', data: audioData })
              } else if (resp.stream_type === 2 && resp.data?.extra_info?.duration) {
                onChunk({ type: 'meta', duration: resp.data.extra_info.duration })
              }
            } catch (e) {
              if (line.startsWith('{')) {
                logger.warn(
                  { line: line.substring(0, 200) },
                  'Failed to parse MiniMax stream chunk',
                )
              }
            }
          }
        })

        res.on('end', () => {
          resolve()
        })
      })

      req.on('error', (error) => {
        logger.error({ error: error.message, stack: error.stack }, 'MiniMax TTS stream error')
        reject(new Error(`Network error: ${error.message}`))
      })

      req.write(JSON.stringify(payload))
      req.end()
    })
  }
}
