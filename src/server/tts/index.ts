import { env, configManager } from '../config/env'
import { EdgeTTSService } from './tts'
import { DolphinTTSService } from './dolphin-tts'
import { BailianTTSService } from './bailian-tts'
import { MiniMaxTTSService } from './minimax-tts'
import { getTTSCache, setTTSCache } from './tts-cache'
import { logger } from '../utils/logger'

export interface BatchContext {
  batchId: string
  batchIndex: number
  isBatchComplete: boolean
}

export interface TTSService {
  synthesize(
    text: string,
    speed?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
    batchContext?: BatchContext,
  ): Promise<{ audioBuffer: Buffer; duration: number }>
}

class CachedTTSService implements TTSService {
  private innerService: TTSService
  private voiceId?: number

  constructor(innerService: TTSService, voiceId?: number) {
    this.innerService = innerService
    this.voiceId = voiceId
  }

  async synthesize(
    text: string,
    speed?: string,
    callback?: {
      meta: (meta: any) => void
      audio: (audio: Buffer) => void
    },
    batchContext?: BatchContext,
  ): Promise<{ audioBuffer: Buffer; duration: number }> {
    const cacheKey = `${text}|${speed}|${this.voiceId || 'default'}`

    const cached = await getTTSCache(text, speed || 'stand', this.voiceId)
    if (cached) {
      logger.debug({ cacheKey: cacheKey.substring(0, 32) }, 'TTS cache hit')
      callback?.audio(cached.audioBuffer)
      return cached
    }

    logger.debug({ cacheKey: cacheKey.substring(0, 32) }, 'TTS cache miss, synthesizing')

    const result = await this.innerService.synthesize(text, speed, callback, batchContext)

    if (result.audioBuffer.length > 0) {
      await setTTSCache(text, speed || 'stand', result.audioBuffer, result.duration, this.voiceId)
    }

    return result
  }
}

let ttsService: TTSService | null = null
let currentTTSProvider: string = env.TTS_PROVIDER
let currentVoiceId: number = env.DOLPHIN_TTS_VOICE_ID
let currentEdgeVoice: string = env.EDGE_TTS_VOICE

/**
 * 创建 TTS 服务实例
 * 根据当前配置选择合适的提供商
 */
function createTTSService(): TTSService {
  const provider = configManager.get('TTS_PROVIDER')
  const voiceId = configManager.get('DOLPHIN_TTS_VOICE_ID')
  const edgeVoice = configManager.get('EDGE_TTS_VOICE')

  let innerService: TTSService

  if (provider === 'dolphin') {
    innerService = new DolphinTTSService()
    logger.info(`[TTS] 使用 Dolphin 提供商, voiceId=${voiceId}`)
    return new CachedTTSService(innerService, voiceId)
  } else if (provider === 'bailian') {
    innerService = new BailianTTSService()
    logger.info('[TTS] 使用 Bailian 提供商')
    return new CachedTTSService(innerService)
  } else if (provider === 'minimax') {
    innerService = new MiniMaxTTSService()
    logger.info('[TTS] 使用 MiniMax 提供商')
    return new CachedTTSService(innerService)
  } else {
    innerService = new EdgeTTSService({ voice: edgeVoice })
    logger.info(`[TTS] 使用 Edge 提供商, voice=${edgeVoice}`)
    return new CachedTTSService(innerService)
  }
}

/**
 * 检查 TTS 配置是否发生变化
 */
function hasTTSConfigChanged(): boolean {
  const provider = configManager.get('TTS_PROVIDER')
  const voiceId = configManager.get('DOLPHIN_TTS_VOICE_ID')
  const edgeVoice = configManager.get('EDGE_TTS_VOICE')

  return (
    provider !== currentTTSProvider || voiceId !== currentVoiceId || edgeVoice !== currentEdgeVoice
  )
}

/**
 * 更新当前 TTS 配置缓存
 */
function updateTTSConfigCache(): void {
  currentTTSProvider = configManager.get('TTS_PROVIDER')
  currentVoiceId = configManager.get('DOLPHIN_TTS_VOICE_ID')
  currentEdgeVoice = configManager.get('EDGE_TTS_VOICE')
}

export function getTTSService(): TTSService {
  // 如果服务未创建或配置已变更，重新创建服务
  if (!ttsService || hasTTSConfigChanged()) {
    if (ttsService && hasTTSConfigChanged()) {
      logger.info('[TTS] 检测到配置变更，重新初始化 TTS 服务')
    }
    ttsService = createTTSService()
    updateTTSConfigCache()
  }
  return ttsService
}

export function initTTSService(): void {
  ttsService = createTTSService()
  updateTTSConfigCache()
  logger.info('[TTS] TTS 服务初始化完成')
}

/**
 * 重置 TTS 服务（用于配置变更后强制重建）
 */
export function resetTTSService(): void {
  ttsService = null
  logger.info('[TTS] TTS 服务已重置')
}

// 监听 TTS 相关配置变更
configManager.on('change:TTS_PROVIDER', () => {
  logger.info('[TTS] TTS_PROVIDER 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:DOLPHIN_TTS_VOICE_ID', () => {
  logger.info('[TTS] DOLPHIN_TTS_VOICE_ID 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:EDGE_TTS_VOICE', () => {
  logger.info('[TTS] EDGE_TTS_VOICE 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:DOLPHIN_TTS_TOKEN', () => {
  logger.info('[TTS] DOLPHIN_TTS_TOKEN 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:DOLPHIN_TTS_SPEED_FAST', () => {
  logger.info('[TTS] DOLPHIN_TTS_SPEED_FAST 配置变更')
})

configManager.on('change:DOLPHIN_TTS_SPEED_NORMAL', () => {
  logger.info('[TTS] DOLPHIN_TTS_SPEED_NORMAL 配置变更')
})

configManager.on('change:DOLPHIN_TTS_SPEED_SLOW', () => {
  logger.info('[TTS] DOLPHIN_TTS_SPEED_SLOW 配置变更')
})

configManager.on('change:DOLPHIN_TTS_HOSTNAME', () => {
  logger.info('[TTS] DOLPHIN_TTS_HOSTNAME 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:DOLPHIN_TTS_PORT', () => {
  logger.info('[TTS] DOLPHIN_TTS_PORT 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:DOLPHIN_TTS_PATH', () => {
  logger.info('[TTS] DOLPHIN_TTS_PATH 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:BAILIAN_TTS_API_KEY', () => {
  logger.info('[TTS] BAILIAN_TTS_API_KEY 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:BAILIAN_TTS_MODEL', () => {
  logger.info('[TTS] BAILIAN_TTS_MODEL 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:BAILIAN_TTS_VOICE', () => {
  logger.info('[TTS] BAILIAN_TTS_VOICE 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:MINIMAX_TTS_API_KEY', () => {
  logger.info('[TTS] MINIMAX_TTS_API_KEY 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:MINIMAX_TTS_GROUP_ID', () => {
  logger.info('[TTS] MINIMAX_TTS_GROUP_ID 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:MINIMAX_TTS_MODEL', () => {
  logger.info('[TTS] MINIMAX_TTS_MODEL 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:MINIMAX_TTS_VOICE', () => {
  logger.info('[TTS] MINIMAX_TTS_VOICE 配置变更，重置服务')
  resetTTSService()
})

configManager.on('change:MINIMAX_TTS_BASE_URL', () => {
  logger.info('[TTS] MINIMAX_TTS_BASE_URL 配置变更，重置服务')
  resetTTSService()
})

export { EdgeTTSService, DolphinTTSService, BailianTTSService, MiniMaxTTSService }
export type { TTSResult } from './tts'
