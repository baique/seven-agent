import { request, get } from 'https'
import { lookup } from 'dns/promises'
import { logger, cleanTextForTTS } from '../utils'
import { configManager } from '../config/env'
import type { TTSResult } from './tts'

export interface DolphinTTSResponse {
  code: number
  port: number
  url: string
  voice_path: string
}

type QueueTask = {
  text: string
  speed?: string
  retries: number
  resolve: (result: TTSResult) => void
  reject: (error: Error) => void
}

const taskQueue: QueueTask[] = []
let activeCount = 0
const MAX_CONCURRENT = 3
const MAX_RETRIES = 2

async function processQueue(): Promise<void> {
  while (activeCount < MAX_CONCURRENT && taskQueue.length > 0) {
    activeCount++
    const task = taskQueue.shift()!

    logger.debug({ queueLength: taskQueue.length, activeCount }, 'Dolphin TTS processing task')

    synthesizeDirect(task.text, task.speed)
      .then((result) => task.resolve(result))
      .catch((error) => {
        const err = error as Error & { statusCode?: number }
        if ((err.statusCode === 429 || err.message.includes('429')) && task.retries < MAX_RETRIES) {
          logger.warn({ retries: task.retries }, 'Dolphin TTS rate limited, retrying')
          taskQueue.unshift({ ...task, retries: task.retries + 1 })
        } else {
          task.reject(err)
        }
      })
      .finally(() => {
        activeCount--
        processQueue()
      })
  }
}

async function synthesizeDirect(text: string, speed?: string): Promise<TTSResult> {
  const cleanedText = cleanTextForTTS(text)

  if (!cleanedText) {
    return { audioBuffer: Buffer.alloc(0), duration: 0 }
  }

  const token = configManager.get('DOLPHIN_TTS_TOKEN')
  if (!token) {
    throw new Error('DOLPHIN_TTS_TOKEN is not configured')
  }

  const ttsResponse = await requestTTS(cleanedText, speed, token)
  const audioBuffer = await downloadAudio(ttsResponse, token)

  const duration = Math.round((audioBuffer.length / 16000) * 0.5)

  logger.debug({ bufferLength: audioBuffer.length, duration }, 'Dolphin TTS success')

  return { audioBuffer, duration }
}

function getSpeedFactor(speed: string): number {
  switch (speed) {
    case 'fast':
      return configManager.get('DOLPHIN_TTS_SPEED_FAST')
    case 'slow':
      return configManager.get('DOLPHIN_TTS_SPEED_SLOW')
    default:
      return configManager.get('DOLPHIN_TTS_SPEED_NORMAL')
  }
}

async function requestTTS(
  text: string,
  speed: string | undefined,
  token: string,
): Promise<DolphinTTSResponse> {
  const speedFactor = getSpeedFactor(speed || 'stand')

  const payload = {
    voice_id: configManager.get('DOLPHIN_TTS_VOICE_ID'),
    to_lang: 'auto',
    format: 'mp3',
    speed_factor: speedFactor,
    pitch_factor: 0,
    volume_change_dB: 4,
    emotion: 0,
    text,
    code: '',
    client_ip: 'ACGN',
  }

  const hostname = configManager.get('DOLPHIN_TTS_HOSTNAME')
  const port = configManager.get('DOLPHIN_TTS_PORT')
  const pathPrefix = configManager.get('DOLPHIN_TTS_PATH')

  // DNS 解析调试
  try {
    const dnsResult = await lookup(hostname, { family: 4 })
    logger.debug({ hostname, resolvedIp: dnsResult.address }, 'Dolphin TTS DNS lookup result')
  } catch (dnsError) {
    logger.warn({ hostname, error: dnsError }, 'Dolphin TTS DNS lookup failed')
  }

  logger.debug(
    { hostname, port, pathPrefix, token: token.substring(0, 8) + '...' },
    'Dolphin TTS request options',
  )

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname,
      port,
      path: `${pathPrefix}?token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.ttson.cn',
        Referer: 'https://www.ttson.cn/',
        'X-Client-header': '34a1eb77495bb7f5198ab57880554dae',
        'X-checkout-Header': '_checkout',
      },
      rejectUnauthorized: false,
    }

    logger.debug(
      {
        reqOptions: { ...reqOptions, headers: { ...reqOptions.headers, 'X-Client-header': '***' } },
      },
      'Dolphin TTS request details',
    )

    const req = request(reqOptions, (res) => {
      const chunks: Buffer[] = []

      res.on('data', (chunk: Buffer) => chunks.push(chunk))

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')

        logger.debug(
          { statusCode: res.statusCode, headers: res.headers, body: body.substring(0, 500) },
          'Dolphin TTS response received',
        )

        if (res.statusCode === 429) {
          const err = new Error('Rate limited') as Error & { statusCode?: number }
          err.statusCode = 429
          reject(err)
          return
        }

        if (res.statusCode && res.statusCode >= 400) {
          logger.error(
            { statusCode: res.statusCode, headers: res.headers, error: body },
            'Dolphin TTS request failed',
          )
          reject(new Error(`Dolphin TTS request failed: ${res.statusCode}, body: ${body}`))
          return
        }

        try {
          const jsonResp: DolphinTTSResponse = JSON.parse(body)

          if (jsonResp.code !== 200) {
            logger.error({ response: jsonResp }, 'Dolphin TTS API error')
            reject(new Error(`Dolphin TTS API error: code ${jsonResp.code}`))
            return
          }

          resolve(jsonResp)
        } catch (e) {
          logger.error({ error: e, body: body.substring(0, 500) }, 'Failed to parse TTS response')
          reject(new Error('Failed to parse TTS response'))
        }
      })
    })

    req.on('error', (error) => {
      logger.error(
        { error, message: error.message, code: (error as any).code, hostname, port },
        'Dolphin TTS request error',
      )
      reject(error)
    })

    req.write(JSON.stringify(payload))
    req.end()
  })
}

async function downloadAudio(ttsResponse: DolphinTTSResponse, token: string): Promise<Buffer> {
  const { url, port, voice_path } = ttsResponse

  const downloadUrl = `${url}:${port}/flashsummary/retrieveFileData?stream=True&token=${token}&voice_audio_path=${encodeURIComponent(voice_path)}`

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(downloadUrl)

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      rejectUnauthorized: false,
    }

    const req = get(reqOptions, (res) => {
      const chunks: Buffer[] = []

      res.on('data', (chunk: Buffer) => chunks.push(chunk))

      res.on('end', () => {
        const audioBuffer = Buffer.concat(chunks)

        if (res.statusCode && res.statusCode >= 400) {
          logger.error({ statusCode: res.statusCode }, 'Dolphin TTS download failed')
          reject(new Error(`Dolphin TTS download failed: ${res.statusCode}`))
          return
        }

        resolve(audioBuffer)
      })
    })

    req.on('error', (error) => {
      logger.error({ error }, 'Dolphin TTS download error')
      reject(error)
    })
  })
}

export class DolphinTTSService {
  async synthesize(
    text: string,
    speed?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
  ): Promise<TTSResult> {
    return new Promise((resolve, reject) => {
      taskQueue.push({
        text,
        speed,
        retries: 0,
        resolve: (result) => {
          callback?.meta({ duration: result.duration })
          callback?.audio(result.audioBuffer)
          resolve(result)
        },
        reject,
      })

      logger.debug({ queueLength: taskQueue.length, activeCount }, 'Dolphin TTS task queued')

      processQueue()
    })
  }
}

export function getDolphinTTSService(): DolphinTTSService {
  return new DolphinTTSService()
}
