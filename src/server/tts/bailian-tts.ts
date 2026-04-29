import WebSocket from 'ws'
import { logger, cleanTextForTTS } from '../utils'
import { env } from '../config/env'
import type { TTSResult } from './tts'
import type { BatchContext } from './index'
import type { Socket } from 'net'

interface BailianTTSHeader {
  task_id: string
  event: string
  status?: number
  error_code?: string
  error_message?: string
}

interface BailianTTSResponse {
  header: BailianTTSHeader
  payload?: {
    output?: {
      audio?: string
      sentence?: {
        begin_time?: number
        end_time?: number
      }
    }
  }
}

/**
 * HTTP批量TTS单个请求状态
 */
interface HTTPBatchRequest {
  chunks: Buffer[]
  resolve: (result: TTSResult) => void
  reject: (error: Error) => void
  resolved: boolean
}

/**
 * HTTP批量TTS会话状态
 */
interface HTTPBatchSession {
  taskId: string
  ws: WebSocket
  chunks: Buffer[]
  totalDuration: number
  isStarted: boolean
  pendingRequests: HTTPBatchRequest[]
  timeout: NodeJS.Timeout
  /** 最后一次活动时间，用于超时检测 */
  lastActivityTime: number
  /** 超时检查定时器 */
  timeoutChecker?: NodeJS.Timeout
  /** 已解决的请求数量，用于顺序匹配音频 */
  resolvedCount: number
}

/**
 * 批量TTS会话状态
 */
export interface BatchTTSSession {
  batchId: string
  taskId: string
  ws: WebSocket
  speed: string
  chunks: Buffer[]
  totalDuration: number
  currentIndex: number
  pendingTexts: Map<number, string>
  isStarted: boolean
  isFinished: boolean
  clientSocket?: Socket
  /** 最后一次活动时间，用于超时检测 */
  lastActivityTime: number
  /** 超时检查定时器 */
  timeoutChecker?: NodeJS.Timeout
}

/**
 * 批量TTS音频回调数据
 */
export interface BatchTTSAudioCallback {
  batchId: string
  index: number
  audioBase64: string
}

/**
 * 批量TTS完成回调数据
 */
export interface BatchTTSCompleteCallback {
  batchId: string
  duration: number
}

const SPEED_MAP: Record<string, number> = {
  stand: 1.0,
  standard: 1.0,
  normal: 1.0,
  slow: 0.8,
  fast: 1.3,
}

function cleanTextForBailianTTS(text: string): string {
  // 先使用通用的TTS文本清理
  text = cleanTextForTTS(text)

  const hasSSML = /<speak[^>]*>/i.test(text)
  if (!hasSSML) {
    return text.trim()
  }

  const escapeXML = (str: string): string => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  let result = ''
  let lastIndex = 0
  const tagRegex = /<\/?[a-zA-Z][^>]*>/g
  let match

  while ((match = tagRegex.exec(text)) !== null) {
    result += escapeXML(text.substring(lastIndex, match.index))
    result += match[0]
    lastIndex = match.index + match[0].length
  }

  result += escapeXML(text.substring(lastIndex))

  return result.trim()
}

function getSpeechRate(speed?: string): number {
  if (!speed) return 1.0
  if (SPEED_MAP[speed.toLowerCase()] !== undefined) {
    return SPEED_MAP[speed.toLowerCase()]
  }
  return 1.0
}

export class BailianTTSService {
  private apiKey: string
  private model: string
  private voice: string
  private wsUrl: string
  private static batchSessions: Map<string, HTTPBatchSession> = new Map()

  constructor() {
    this.apiKey = env.BAILIAN_TTS_API_KEY || ''
    this.model = env.BAILIAN_TTS_MODEL || 'cosyvoice-v3-flash'
    this.voice = env.BAILIAN_TTS_VOICE || 'longfeifei_v3'
    this.wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
  }

  async synthesize(
    text: string,
    speed?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
    batchContext?: BatchContext,
  ): Promise<TTSResult> {
    const cleanedText = cleanTextForBailianTTS(text)

    if (!cleanedText) {
      return { audioBuffer: Buffer.alloc(0), duration: 0 }
    }

    if (!this.apiKey) {
      throw new Error('BAILIAN_TTS_API_KEY is not configured')
    }

    if (batchContext) {
      return this.synthesizeBatch(cleanedText, batchContext, speed)
    }

    return this.synthesizeSingle(cleanedText, speed, callback)
  }

  private async synthesizeBatch(
    cleanedText: string,
    batchContext: BatchContext,
    speed?: string,
  ): Promise<TTSResult> {
    const { batchId, isBatchComplete } = batchContext
    let session = BailianTTSService.batchSessions.get(batchId)

    if (!session) {
      session = this.createBatchSession(batchId, speed)
      BailianTTSService.batchSessions.set(batchId, session)
    }

    if (!session.isStarted) {
      await this.waitForSessionStart(session)
    }

    return this.sendBatchText(session, cleanedText, isBatchComplete)
  }

  private createBatchSession(batchId: string, speed?: string): HTTPBatchSession {
    const taskId = `${Date.now().toString(16)}-${Math.random().toString(36).substring(2, 18)}`

    const ws = new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `bearer ${this.apiKey}`,
      },
    })

    const session: HTTPBatchSession = {
      taskId,
      ws,
      chunks: [],
      totalDuration: 0,
      isStarted: false,
      pendingRequests: [],
      timeout: setTimeout(() => {
        ws.close()
        BailianTTSService.batchSessions.delete(batchId)
      }, 120000),
      lastActivityTime: Date.now(),
      resolvedCount: 0,
    }

    ws.on('open', () => {
      logger.debug({ taskId, batchId }, '[Bailian TTS Batch] WebSocket connected')

      const runTaskRequest = {
        header: {
          action: 'run-task',
          task_id: taskId,
          streaming: 'duplex',
        },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: this.model,
          parameters: {
            enable_ssml: false,
            text_type: 'PlainText',
            voice: this.voice,
            format: 'mp3',
            sample_rate: 22050,
            volume: 90,
            rate: getSpeechRate(speed),
            pitch: 1, // 音调
          },
          input: {},
        },
      }

      ws.send(JSON.stringify(runTaskRequest))
    })

    ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
      this.handleBatchMessage(session, batchId, data, isBinary)
    })

    ws.on('error', (error) => {
      clearTimeout(session.timeout)
      logger.error({ batchId, error }, '[Bailian TTS Batch] WebSocket error')
      session.pendingRequests.forEach((req) => req.reject(error))
      BailianTTSService.batchSessions.delete(batchId)
    })

    ws.on('close', (code, reason) => {
      clearTimeout(session.timeout)
      logger.debug(
        { batchId, code, reason: reason.toString() },
        '[Bailian TTS Batch] WebSocket closed',
      )
      BailianTTSService.batchSessions.delete(batchId)
    })

    return session
  }

  private waitForSessionStart(session: HTTPBatchSession): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (session.isStarted) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 50)

      setTimeout(() => {
        clearInterval(checkInterval)
        reject(new Error('Batch session start timeout'))
      }, 30000)
    })
  }

  private sendBatchText(
    session: HTTPBatchSession,
    text: string,
    isBatchComplete?: boolean,
  ): Promise<TTSResult> {
    return new Promise((resolve, reject) => {
      if (session.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'))
        return
      }

      const request: HTTPBatchRequest = {
        chunks: [],
        resolve,
        reject,
        resolved: false,
      }
      session.pendingRequests.push(request)

      const continueTaskRequest = {
        header: {
          action: 'continue-task',
          task_id: session.taskId,
          streaming: 'duplex',
        },
        payload: {
          input: {
            text: text,
          },
        },
      }

      session.ws.send(JSON.stringify(continueTaskRequest))
      session.lastActivityTime = Date.now()
      logger.debug(
        { taskId: session.taskId, text: text.substring(0, 30) },
        '[Bailian TTS Batch] Text sent',
      )

      if (isBatchComplete) {
        const finishTaskRequest = {
          header: {
            action: 'finish-task',
            task_id: session.taskId,
            streaming: 'duplex',
          },
          payload: {
            input: {},
          },
        }

        session.ws.send(JSON.stringify(finishTaskRequest))
        logger.debug({ taskId: session.taskId }, '[Bailian TTS Batch] Finish request sent')
      }
    })
  }

  private handleBatchMessage(
    session: HTTPBatchSession,
    batchId: string,
    data: WebSocket.Data,
    isBinary: boolean,
  ): void {
    session.lastActivityTime = Date.now()

    if (isBinary) {
      const audioBuffer = Buffer.from(data as Buffer)
      const pendingRequest = session.pendingRequests.find((r) => !r.resolved)
      if (pendingRequest) {
        pendingRequest.chunks.push(audioBuffer)
      }
      return
    }

    try {
      const response: BailianTTSResponse = JSON.parse(data.toString())
      const { header, payload } = response

      if (header.event === 'task-started') {
        session.isStarted = true
        logger.debug({ batchId }, '[Bailian TTS Batch] Task started')

        /** 启动超时检查定时器，每5秒检查一次 */
        session.timeoutChecker = setInterval(() => {
          const elapsed = Date.now() - session.lastActivityTime
          /** 如果超过20秒没有活动，自动结束任务 */
          if (elapsed > 20000 && session.pendingRequests.every((r) => r.resolved)) {
            logger.warn(
              { batchId, elapsedSeconds: Math.round(elapsed / 1000) },
              '[Bailian TTS Batch] Auto finishing due to inactivity timeout',
            )
            this.closeBatchSession(session, batchId)
          }
        }, 5000)
      } else if (header.event === 'result-generated') {
        /** 按顺序分配音频给请求 */
        const requestIndex = session.resolvedCount
        const pendingRequest = session.pendingRequests[requestIndex]

        if (pendingRequest && !pendingRequest.resolved && payload?.output?.audio) {
          const audioBuffer = Buffer.from(payload.output.audio, 'base64')
          pendingRequest.chunks.push(audioBuffer)
          const duration = payload.output.sentence?.end_time || 0

          pendingRequest.resolved = true
          session.resolvedCount++
          const audioResult = Buffer.concat(pendingRequest.chunks)
          pendingRequest.resolve({
            audioBuffer: audioResult,
            duration: duration || Math.round((audioResult.length / 22050) * 0.5),
          })
          logger.debug(
            { batchId, requestIndex, bufferLength: audioResult.length },
            '[Bailian TTS Batch] Request resolved',
          )
        }
      } else if (header.event === 'task-finished') {
        this.closeBatchSession(session, batchId)
        logger.debug({ batchId }, '[Bailian TTS Batch] Task finished')

        session.pendingRequests
          .filter((r) => !r.resolved)
          .forEach((r) => {
            r.resolved = true
            const audioBuffer = Buffer.concat(r.chunks)
            r.resolve({ audioBuffer, duration: Math.round((audioBuffer.length / 22050) * 0.5) })
          })
      } else if (header.event === 'task-failed') {
        this.closeBatchSession(session, batchId)
        logger.error({ batchId, response }, '[Bailian TTS Batch] Task failed')
        const error = new Error(
          `Bailian TTS task failed: ${header.error_message || header.error_code || 'Unknown error'}`,
        )
        session.pendingRequests
          .filter((r) => !r.resolved)
          .forEach((r) => {
            r.resolved = true
            r.reject(error)
          })
      }
    } catch (error) {
      logger.error(
        { error, data: data.toString().substring(0, 200) },
        '[Bailian TTS Batch] Parse error',
      )
    }
  }

  /**
   * 关闭批量会话
   */
  private closeBatchSession(session: HTTPBatchSession, batchId: string): void {
    clearTimeout(session.timeout)
    if (session.timeoutChecker) {
      clearInterval(session.timeoutChecker)
      session.timeoutChecker = undefined
    }
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close()
    }
    BailianTTSService.batchSessions.delete(batchId)
  }

  private async synthesizeSingle(
    cleanedText: string,
    speed?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
  ): Promise<TTSResult> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalDuration = 0
      const taskId = `${Date.now().toString(16)}-${Math.random().toString(36).substring(2, 18)}`

      const ws = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: `bearer ${this.apiKey}`,
        },
      })

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Bailian TTS timeout'))
      }, 60000)

      ws.on('open', () => {
        logger.debug({ taskId }, '[Bailian TTS] WebSocket connected')

        const runTaskRequest = {
          header: {
            action: 'run-task',
            task_id: taskId,
            streaming: 'duplex',
          },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: this.model,
            parameters: {
              text_type: 'PlainText',
              voice: this.voice,
              format: 'mp3',
              sample_rate: 22050,
              volume: 100,
              rate: getSpeechRate(speed),
            },
            input: {},
          },
        }

        ws.send(JSON.stringify(runTaskRequest))
      })

      ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
        if (isBinary) {
          const audioBuffer = Buffer.from(data as Buffer)
          chunks.push(audioBuffer)
          callback?.audio(audioBuffer)
          return
        }

        try {
          const response: BailianTTSResponse = JSON.parse(data.toString())
          const { header, payload } = response

          logger.debug({ event: header.event }, '[Bailian TTS] Received event')

          if (header.event === 'task-started') {
            const continueTaskRequest = {
              header: {
                action: 'continue-task',
                task_id: taskId,
                streaming: 'duplex',
              },
              payload: {
                input: {
                  text: cleanedText,
                },
              },
            }

            ws.send(JSON.stringify(continueTaskRequest))

            const finishTaskRequest = {
              header: {
                action: 'finish-task',
                task_id: taskId,
                streaming: 'duplex',
              },
              payload: {
                input: {},
              },
            }

            ws.send(JSON.stringify(finishTaskRequest))
          } else if (header.event === 'result-generated') {
            if (payload?.output?.audio) {
              const audioBuffer = Buffer.from(payload.output.audio, 'base64')
              chunks.push(audioBuffer)
              callback?.audio(audioBuffer)
            }
            if (payload?.output?.sentence?.end_time) {
              totalDuration = Math.max(totalDuration, payload.output.sentence.end_time)
            }
          } else if (header.event === 'task-finished') {
            clearTimeout(timeout)
            ws.close()

            const audioBuffer = Buffer.concat(chunks)
            const duration = totalDuration || Math.round((audioBuffer.length / 22050) * 0.5)

            logger.debug(
              { taskId, bufferLength: audioBuffer.length, duration },
              '[Bailian TTS] Synthesis completed',
            )

            callback?.meta({ duration })
            resolve({ audioBuffer, duration })
          } else if (header.event === 'task-failed') {
            clearTimeout(timeout)
            ws.close()
            logger.error({ response }, '[Bailian TTS] Task failed')
            reject(
              new Error(
                `Bailian TTS task failed: ${header.error_message || header.error_code || 'Unknown error'}`,
              ),
            )
          }
        } catch (error) {
          logger.error(
            { error, data: data.toString().substring(0, 200) },
            '[Bailian TTS] Parse error',
          )
        }
      })

      ws.on('error', (error) => {
        clearTimeout(timeout)
        logger.error({ error }, '[Bailian TTS] WebSocket error')
        reject(error)
      })

      ws.on('close', (code, reason) => {
        clearTimeout(timeout)
        logger.debug({ code, reason: reason.toString() }, '[Bailian TTS] WebSocket closed')
      })
    })
  }
}

export function getBailianTTSService(): BailianTTSService {
  return new BailianTTSService()
}

/**
 * 批量TTS管理器
 * 管理多个批量TTS会话，每个会话维护一个WebSocket连接
 */
export class BatchTTSManager {
  private apiKey: string
  private model: string
  private voice: string
  private wsUrl: string
  private sessions: Map<string, BatchTTSSession> = new Map()
  private audioCallback?: (data: BatchTTSAudioCallback) => void
  private completeCallback?: (data: BatchTTSCompleteCallback) => void

  constructor() {
    this.apiKey = env.BAILIAN_TTS_API_KEY || ''
    this.model = env.BAILIAN_TTS_MODEL || 'cosyvoice-v3-flash'
    this.voice = env.BAILIAN_TTS_VOICE || 'longfeifei_v3'
    this.wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
  }

  /**
   * 设置音频回调
   */
  onAudio(callback: (data: BatchTTSAudioCallback) => void): void {
    this.audioCallback = callback
  }

  /**
   * 设置完成回调
   */
  onComplete(callback: (data: BatchTTSCompleteCallback) => void): void {
    this.completeCallback = callback
  }

  /**
   * 开始批量TTS会话
   */
  async startBatch(batchId: string, speed: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('BAILIAN_TTS_API_KEY is not configured')
    }

    if (this.sessions.has(batchId)) {
      logger.warn({ batchId }, '[Batch TTS] Session already exists')
      return
    }

    const taskId = `${Date.now().toString(16)}-${Math.random().toString(36).substring(2, 18)}`

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: `bearer ${this.apiKey}`,
        },
      })

      const session: BatchTTSSession = {
        batchId,
        taskId,
        ws,
        speed,
        chunks: [],
        totalDuration: 0,
        currentIndex: 0,
        pendingTexts: new Map(),
        isStarted: false,
        isFinished: false,
        lastActivityTime: Date.now(),
      }

      this.sessions.set(batchId, session)

      const timeout = setTimeout(() => {
        ws.close()
        this.sessions.delete(batchId)
        reject(new Error('Batch TTS start timeout'))
      }, 30000)

      ws.on('open', () => {
        clearTimeout(timeout)
        logger.debug({ batchId, taskId }, '[Batch TTS] WebSocket connected')

        const runTaskRequest = {
          header: {
            action: 'run-task',
            task_id: taskId,
            streaming: 'duplex',
          },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: this.model,
            parameters: {
              text_type: 'PlainText',
              voice: this.voice,
              format: 'mp3',
              sample_rate: 22050,
              volume: 100,
              rate: getSpeechRate(speed),
            },
            input: {},
          },
        }

        ws.send(JSON.stringify(runTaskRequest))
      })

      ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
        this.handleMessage(session, data, isBinary)
      })

      ws.on('error', (error) => {
        logger.error({ batchId, error }, '[Batch TTS] WebSocket error')
        this.sessions.delete(batchId)
      })

      ws.on('close', (code, reason) => {
        logger.debug({ batchId, code, reason: reason.toString() }, '[Batch TTS] WebSocket closed')
        this.sessions.delete(batchId)
      })

      const checkStarted = setInterval(() => {
        if (session.isStarted) {
          clearInterval(checkStarted)
          resolve()
        }
      }, 100)

      setTimeout(() => {
        clearInterval(checkStarted)
        if (!session.isStarted) {
          reject(new Error('Batch TTS start timeout'))
        }
      }, 30000)
    })
  }

  /**
   * 发送文本片段
   */
  sendChunk(batchId: string, index: number, text: string): void {
    const session = this.sessions.get(batchId)
    if (!session) {
      logger.error({ batchId }, '[Batch TTS] Session not found')
      return
    }

    if (session.isFinished) {
      logger.warn({ batchId }, '[Batch TTS] Session already finished')
      return
    }

    const cleanedText = cleanTextForBailianTTS(text)
    if (!cleanedText) {
      logger.debug({ batchId, index }, '[Batch TTS] Empty text after cleaning, skipping')
      return
    }

    if (!session.isStarted) {
      session.pendingTexts.set(index, cleanedText)
      logger.debug(
        { batchId, index, pendingCount: session.pendingTexts.size },
        '[Batch TTS] Text queued (waiting for start)',
      )
      return
    }

    this.sendTextToSession(session, index, cleanedText)
  }

  /**
   * 发送文本到会话
   */
  private sendTextToSession(session: BatchTTSSession, index: number, text: string): void {
    if (session.ws.readyState !== WebSocket.OPEN) {
      logger.error({ batchId: session.batchId, index }, '[Batch TTS] WebSocket not open')
      return
    }

    const continueTaskRequest = {
      header: {
        action: 'continue-task',
        task_id: session.taskId,
        streaming: 'duplex',
      },
      payload: {
        input: {
          text: text,
        },
      },
    }

    session.ws.send(JSON.stringify(continueTaskRequest))
    session.currentIndex = index
    session.lastActivityTime = Date.now()
    logger.debug(
      { batchId: session.batchId, index, text: text.substring(0, 30) },
      '[Batch TTS] Text sent',
    )
  }

  /**
   * 完成批量TTS会话
   */
  finishBatch(batchId: string): void {
    const session = this.sessions.get(batchId)
    if (!session) {
      logger.error({ batchId }, '[Batch TTS] Session not found')
      return
    }

    if (session.isFinished) {
      logger.warn({ batchId }, '[Batch TTS] Session already finished')
      return
    }

    session.isFinished = true

    /** 清除超时检查定时器 */
    if (session.timeoutChecker) {
      clearInterval(session.timeoutChecker)
      session.timeoutChecker = undefined
    }

    if (session.ws.readyState === WebSocket.OPEN) {
      const finishTaskRequest = {
        header: {
          action: 'finish-task',
          task_id: session.taskId,
          streaming: 'duplex',
        },
        payload: {
          input: {},
        },
      }

      session.ws.send(JSON.stringify(finishTaskRequest))
      logger.debug({ batchId }, '[Batch TTS] Finish request sent')
    }
  }

  /**
   * 取消批量TTS会话
   */
  cancelBatch(batchId: string): void {
    const session = this.sessions.get(batchId)
    if (!session) {
      return
    }

    /** 清除超时检查定时器 */
    if (session.timeoutChecker) {
      clearInterval(session.timeoutChecker)
      session.timeoutChecker = undefined
    }

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close()
    }

    this.sessions.delete(batchId)
    logger.debug({ batchId }, '[Batch TTS] Session cancelled')
  }

  /**
   * 处理WebSocket消息
   */
  private handleMessage(session: BatchTTSSession, data: WebSocket.Data, isBinary: boolean): void {
    if (isBinary) {
      session.lastActivityTime = Date.now()
      const audioBuffer = Buffer.from(data as Buffer)
      session.chunks.push(audioBuffer)

      if (this.audioCallback) {
        this.audioCallback({
          batchId: session.batchId,
          index: session.currentIndex,
          audioBase64: audioBuffer.toString('base64'),
        })
      }
      return
    }

    try {
      const response: BailianTTSResponse = JSON.parse(data.toString())
      const { header, payload } = response

      if (header.event === 'task-started') {
        session.isStarted = true
        session.lastActivityTime = Date.now()
        logger.debug({ batchId: session.batchId }, '[Batch TTS] Task started')

        /** 启动超时检查定时器，每5秒检查一次 */
        session.timeoutChecker = setInterval(() => {
          const elapsed = Date.now() - session.lastActivityTime
          /** 如果超过20秒没有活动，自动结束任务 */
          if (elapsed > 20000 && !session.isFinished) {
            logger.warn(
              { batchId: session.batchId, elapsedSeconds: Math.round(elapsed / 1000) },
              '[Batch TTS] Auto finishing due to inactivity timeout',
            )
            this.finishBatch(session.batchId)
          }
        }, 5000)

        for (const [index, text] of session.pendingTexts) {
          this.sendTextToSession(session, index, text)
        }
        session.pendingTexts.clear()
      } else if (header.event === 'result-generated') {
        session.lastActivityTime = Date.now()
        if (payload?.output?.audio) {
          const audioBuffer = Buffer.from(payload.output.audio, 'base64')
          session.chunks.push(audioBuffer)

          if (this.audioCallback) {
            this.audioCallback({
              batchId: session.batchId,
              index: session.currentIndex,
              audioBase64: audioBuffer.toString('base64'),
            })
          }
        }
        if (payload?.output?.sentence?.end_time) {
          session.totalDuration = Math.max(session.totalDuration, payload.output.sentence.end_time)
        }
      } else if (header.event === 'task-finished') {
        /** 清除超时检查定时器 */
        if (session.timeoutChecker) {
          clearInterval(session.timeoutChecker)
          session.timeoutChecker = undefined
        }

        const duration =
          session.totalDuration || Math.round((Buffer.concat(session.chunks).length / 22050) * 0.5)

        logger.debug(
          {
            batchId: session.batchId,
            bufferLength: Buffer.concat(session.chunks).length,
            duration,
          },
          '[Batch TTS] Task finished',
        )

        if (this.completeCallback) {
          this.completeCallback({
            batchId: session.batchId,
            duration,
          })
        }

        session.ws.close()
        this.sessions.delete(session.batchId)
      } else if (header.event === 'task-failed') {
        /** 清除超时检查定时器 */
        if (session.timeoutChecker) {
          clearInterval(session.timeoutChecker)
          session.timeoutChecker = undefined
        }

        logger.error({ batchId: session.batchId, response }, '[Batch TTS] Task failed')
        session.ws.close()
        this.sessions.delete(session.batchId)
      }
    } catch (error) {
      logger.error(
        { batchId: session.batchId, error, data: data.toString().substring(0, 200) },
        '[Batch TTS] Parse error',
      )
    }
  }

  /**
   * 获取会话
   */
  getSession(batchId: string): BatchTTSSession | undefined {
    return this.sessions.get(batchId)
  }

  /**
   * 检查会话是否存在
   */
  hasSession(batchId: string): boolean {
    return this.sessions.has(batchId)
  }
}

let batchTTSManager: BatchTTSManager | null = null

/**
 * 获取批量TTS管理器单例
 */
export function getBatchTTSManager(): BatchTTSManager {
  if (!batchTTSManager) {
    batchTTSManager = new BatchTTSManager()
  }
  return batchTTSManager
}
