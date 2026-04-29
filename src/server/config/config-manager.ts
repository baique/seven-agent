/**
 * 配置管理器模块
 * 提供配置热重载能力和变更事件通知
 */
import { EventEmitter } from 'events'
import { config } from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import { logger, reloadModuleLogLevels, setLogLevel } from '../utils/logger'

/**
 * 可热重载的配置项类型
 */
export interface ReloadableConfig {
  /** TTS 提供商 */
  TTS_PROVIDER: 'edge' | 'dolphin' | 'bailian' | 'minimax'
  /** Edge TTS 声音 */
  EDGE_TTS_VOICE: string
  /** Dolphin TTS 令牌 */
  DOLPHIN_TTS_TOKEN: string | undefined
  /** Dolphin TTS 语音 ID */
  DOLPHIN_TTS_VOICE_ID: number
  /** Dolphin TTS 语速 */
  DOLPHIN_TTS_SPEED_FAST: number
  DOLPHIN_TTS_SPEED_NORMAL: number
  DOLPHIN_TTS_SPEED_SLOW: number
  /** Dolphin TTS 服务器配置 */
  DOLPHIN_TTS_HOSTNAME: string
  DOLPHIN_TTS_PORT: number
  DOLPHIN_TTS_PATH: string
  /** 阿里百炼 TTS */
  BAILIAN_TTS_API_KEY: string | undefined
  BAILIAN_TTS_MODEL: string
  BAILIAN_TTS_VOICE: string
  /** MiniMax TTS */
  MINIMAX_TTS_API_KEY: string | undefined
  MINIMAX_TTS_GROUP_ID: string | undefined
  MINIMAX_TTS_MODEL: string
  MINIMAX_TTS_VOICE: string
  MINIMAX_TTS_BASE_URL: string
  /** 工具调用限制 */
  TOOL_CALL_LIMITS: string
  MAX_TOOL_CALLS_PER_GRAPH: number
  /** 摘要配置 */
  SUMMARY_UPDATE_COUNT: number
  SUMMARY_FORCE_TOKEN: number
  SUMMARY_BASE_TOKEN: number
  SUMMARY_KEEP_TOKEN: number
  NOTES_TRIGGER_TOKEN: number
  NOTES_TRIGGER_ROUNDS: number
  NOTES_MAX_SIZE: number
  BUFFER_TAIL_PERCENT: number
  /** 极限阈值 */
  EXTREME_THRESHOLD: number
  /** 文件清理 */
  CLEANUP_OLD_FILES_DAYS: number
  /** 调试 */
  LOG_LEVEL: string
  LANGCHAIN_DEBUG: boolean
  /** 代理 */
  HTTPS_PROXY: string | undefined
  HTTP_PROXY: string | undefined
  /** 艾特路由 */
  MENTION_ROUTES: string | undefined
  MENTION_SENDER_NAME: string | undefined
  /** 文件读取限制 */
  FILE_READ_MAX_CHARS: number
  FILE_READ_MAX_LINES: number
  FILE_READ_DEFAULT_LIMIT: number
  /** 笔记重试 */
  SESSION_NOTES_RETRY_COUNT: number
  /** 工具保留策略recent距离 */
  TOOL_RETENTION_RECENT_THRESHOLD: number
  /** 工具密度触发阈值 */
  TOOL_DENSITY_TRIGGER: number
  /** 情感密度触发阈值 */
  EMOTIONAL_DENSITY_TRIGGER: number
  /** 密度触发最低轮数 */
  DENSITY_TRIGGER_MIN_ROUNDS: number
  /** 场景边界验证-工具密度跳变阈值 */
  SCENE_BOUNDARY_TOOL_DENSITY_JUMP: number
  /** 场景边界验证-时间间隔阈值(秒) */
  SCENE_BOUNDARY_TIME_GAP_SECONDS: number
  /** 场景边界验证-检测窗口大小(轮数) */
  SCENE_BOUNDARY_WINDOW_SIZE: number
  /** 笔记片段合并阈值 */
  SEGMENT_MERGE_THRESHOLD: number
  /** 会话笔记整合触发阈值（token数） */
  SESSION_NODE_MAX_TOKENS: number
  /** 情感事件最大保留条数 */
  EMOTIONAL_EVENTS_MAX: number
  /** 场景边界压缩-保留重叠轮数 */
  SCENE_BOUNDARY_OVERLAP_ROUNDS: number
  /** 碎片记忆保留时间（小时） */
  FRAGMENT_MEMORY_RETENTION_HOURS: number
}

/**
 * 配置变更事件类型
 */
export type ConfigChangeEvent = {
  key: keyof ReloadableConfig
  oldValue: ReloadableConfig[keyof ReloadableConfig]
  newValue: ReloadableConfig[keyof ReloadableConfig]
}

/**
 * 配置管理器类
 * 管理 .env 文件的热重载和变更通知
 */
class ConfigManager extends EventEmitter {
  private envPath: string
  private isWatching = false
  private currentConfig: Partial<ReloadableConfig> = {}

  constructor() {
    super()
    this.envPath = this.getEnvPath()
    // 初始加载时先读取 .env 文件到 process.env
    this.initialLoad()
  }

  /**
   * 初始加载配置
   * 先使用 dotenv 加载 .env 文件，再提取配置
   */
  private initialLoad(): void {
    try {
      // 先加载 .env 文件到 process.env
      config({ path: this.envPath, override: false })
      logger.info(`[ConfigManager] 已加载 .env 文件: ${this.envPath}`)
    } catch (error) {
      logger.warn(`[ConfigManager] 加载 .env 文件失败: ${error}`)
    }
    // 然后提取配置
    this.loadConfig()
  }

  /**
   * 获取 .env 文件路径
   * 优先使用 RES_ROOT 环境变量，其次使用 process.cwd()
   */
  private getEnvPath(): string {
    const envFileName = process.env.ENV_FILE || '.env'
    // 使用 RES_ROOT 环境变量或当前工作目录
    const resRoot = process.env.RES_ROOT || process.cwd()
    return path.join(resRoot, envFileName)
  }

  /**
   * 从 process.env 提取可热重载的配置
   */
  private extractConfig(): ReloadableConfig {
    const getEnv = (key: keyof ReloadableConfig, defaultValue?: ReloadableConfig[typeof key]) => {
      const value = process.env[key]
      if (value === undefined) return defaultValue
      return value as ReloadableConfig[typeof key]
    }

    const getNumber = (key: keyof ReloadableConfig, defaultValue: number) => {
      const value = process.env[key]
      if (value === undefined) return defaultValue
      const num = Number(value)
      return isNaN(num) ? defaultValue : num
    }

    return {
      TTS_PROVIDER: getEnv('TTS_PROVIDER', 'edge') as ReloadableConfig['TTS_PROVIDER'],
      EDGE_TTS_VOICE: getEnv('EDGE_TTS_VOICE', 'zh-CN-XiaoxiaoNeural') as string,
      DOLPHIN_TTS_TOKEN: getEnv('DOLPHIN_TTS_TOKEN', undefined) as string | undefined,
      DOLPHIN_TTS_VOICE_ID: getNumber('DOLPHIN_TTS_VOICE_ID', 106),
      DOLPHIN_TTS_SPEED_FAST: getNumber('DOLPHIN_TTS_SPEED_FAST', 1.5),
      DOLPHIN_TTS_SPEED_NORMAL: getNumber('DOLPHIN_TTS_SPEED_NORMAL', 1.1),
      DOLPHIN_TTS_SPEED_SLOW: getNumber('DOLPHIN_TTS_SPEED_SLOW', 0.9),
      DOLPHIN_TTS_HOSTNAME: getEnv(
        'DOLPHIN_TTS_HOSTNAME',
        'u95167-8ncb-3637bf8b.bjb1.seetacloud.com',
      ) as string,
      DOLPHIN_TTS_PORT: getNumber('DOLPHIN_TTS_PORT', 8443),
      DOLPHIN_TTS_PATH: getEnv('DOLPHIN_TTS_PATH', '/flashsummary/tts') as string,
      BAILIAN_TTS_API_KEY: getEnv('BAILIAN_TTS_API_KEY', undefined) as string | undefined,
      BAILIAN_TTS_MODEL: getEnv('BAILIAN_TTS_MODEL', 'cosyvoice-v3-flash') as string,
      BAILIAN_TTS_VOICE: getEnv('BAILIAN_TTS_VOICE', 'longanyang') as string,
      MINIMAX_TTS_API_KEY: getEnv('MINIMAX_TTS_API_KEY', undefined) as string | undefined,
      MINIMAX_TTS_GROUP_ID: getEnv('MINIMAX_TTS_GROUP_ID', undefined) as string | undefined,
      MINIMAX_TTS_MODEL: getEnv('MINIMAX_TTS_MODEL', 'speech-02-turbo') as string,
      MINIMAX_TTS_VOICE: getEnv('MINIMAX_TTS_VOICE', 'maincommon') as string,
      MINIMAX_TTS_BASE_URL: getEnv('MINIMAX_TTS_BASE_URL', 'https://api.minimaxi.com') as string,
      TOOL_CALL_LIMITS: getEnv('TOOL_CALL_LIMITS', '{}') as string,
      MAX_TOOL_CALLS_PER_GRAPH: getNumber('MAX_TOOL_CALLS_PER_GRAPH', 20),
      SUMMARY_UPDATE_COUNT: getNumber('SUMMARY_UPDATE_COUNT', 30),
      SUMMARY_FORCE_TOKEN: getNumber('SUMMARY_FORCE_TOKEN', 60000),
      SUMMARY_BASE_TOKEN: getNumber('SUMMARY_BASE_TOKEN', 45000),
      SUMMARY_KEEP_TOKEN: getNumber('SUMMARY_KEEP_TOKEN', 8000),
      NOTES_TRIGGER_TOKEN: getNumber('NOTES_TRIGGER_TOKEN', 15000),
      NOTES_TRIGGER_ROUNDS: getNumber('NOTES_TRIGGER_ROUNDS', 10),
      NOTES_MAX_SIZE: getNumber('NOTES_MAX_SIZE', 20000),
      BUFFER_TAIL_PERCENT: getNumber('BUFFER_TAIL_PERCENT', 30),
      EXTREME_THRESHOLD: getNumber('EXTREME_THRESHOLD', 100000),
      CLEANUP_OLD_FILES_DAYS: getNumber('CLEANUP_OLD_FILES_DAYS', 7),
      LOG_LEVEL: getEnv('LOG_LEVEL', 'info') as string,
      LANGCHAIN_DEBUG: getEnv('LANGCHAIN_DEBUG', 'false') === 'true',
      HTTPS_PROXY: getEnv('HTTPS_PROXY', undefined) as string | undefined,
      HTTP_PROXY: getEnv('HTTP_PROXY', undefined) as string | undefined,
      MENTION_ROUTES: getEnv('MENTION_ROUTES', undefined) as string | undefined,
      MENTION_SENDER_NAME: getEnv('MENTION_SENDER_NAME', undefined) as string | undefined,
      FILE_READ_MAX_CHARS: getNumber('FILE_READ_MAX_CHARS', 10240),
      FILE_READ_MAX_LINES: getNumber('FILE_READ_MAX_LINES', 2000),
      FILE_READ_DEFAULT_LIMIT: getNumber('FILE_READ_DEFAULT_LIMIT', 500),
      SESSION_NOTES_RETRY_COUNT: getNumber('SESSION_NOTES_RETRY_COUNT', 5),
      TOOL_RETENTION_RECENT_THRESHOLD: getNumber('TOOL_RETENTION_RECENT_THRESHOLD', 10),
      TOOL_DENSITY_TRIGGER: getNumber('TOOL_DENSITY_TRIGGER', 0.6),
      EMOTIONAL_DENSITY_TRIGGER: getNumber('EMOTIONAL_DENSITY_TRIGGER', 0.4),
      DENSITY_TRIGGER_MIN_ROUNDS: getNumber('DENSITY_TRIGGER_MIN_ROUNDS', 5),
      SCENE_BOUNDARY_TOOL_DENSITY_JUMP: getNumber('SCENE_BOUNDARY_TOOL_DENSITY_JUMP', 0.3),
      SCENE_BOUNDARY_TIME_GAP_SECONDS: getNumber('SCENE_BOUNDARY_TIME_GAP_SECONDS', 180),
      SCENE_BOUNDARY_WINDOW_SIZE: getNumber('SCENE_BOUNDARY_WINDOW_SIZE', 5),
      SEGMENT_MERGE_THRESHOLD: getNumber('SEGMENT_MERGE_THRESHOLD', 3),
      SESSION_NODE_MAX_TOKENS: getNumber('SESSION_NODE_MAX_TOKENS', 20000),
      EMOTIONAL_EVENTS_MAX: getNumber('EMOTIONAL_EVENTS_MAX', 30),
      SCENE_BOUNDARY_OVERLAP_ROUNDS: getNumber('SCENE_BOUNDARY_OVERLAP_ROUNDS', 3),
      FRAGMENT_MEMORY_RETENTION_HOURS: getNumber('FRAGMENT_MEMORY_RETENTION_HOURS', 72),
    }
  }

  /**
   * 加载配置并检测变更
   */
  private loadConfig(): void {
    const newConfig = this.extractConfig()
    const changes: ConfigChangeEvent[] = []

    for (const key of Object.keys(newConfig) as Array<keyof ReloadableConfig>) {
      const oldValue = this.currentConfig[key]
      const newValue = newConfig[key]
      if (oldValue !== newValue) {
        changes.push({ key, oldValue, newValue })
      }
    }

    this.currentConfig = newConfig

    // 通知变更（跳过首次加载时从 undefined 到初始值的情况）
    for (const change of changes) {
      // 首次加载时 oldValue 为 undefined，不输出变更日志
      if (change.oldValue !== undefined) {
        logger.info(
          `[ConfigManager] 配置变更: ${change.key} = ${JSON.stringify(change.oldValue)} -> ${JSON.stringify(change.newValue)}`,
        )
      }
      this.emit('change', change)
      this.emit(`change:${change.key}`, change.newValue, change.oldValue)
    }

    // 应用日志级别变更
    this.applyLogLevelChanges(changes)
  }

  /**
   * 应用日志级别变更
   */
  private applyLogLevelChanges(changes: ConfigChangeEvent[]): void {
    let moduleLogLevelsChanged = false

    for (const change of changes) {
      if (change.key === 'LOG_LEVEL') {
        if (change.newValue !== undefined) {
          setLogLevel(String(change.newValue))
          logger.info(`[ConfigManager] 全局日志级别已更新为: ${change.newValue}`)
        }
      } else if ((change.key as string).startsWith('LOG_LEVEL_')) {
        moduleLogLevelsChanged = true
        const moduleName = (change.key as string).replace('LOG_LEVEL_', '').toLowerCase()
        if (change.newValue !== undefined) {
          logger.info(`[ConfigManager] 模块 ${moduleName} 日志级别已更新为: ${change.newValue}`)
        } else {
          logger.info(`[ConfigManager] 模块 ${moduleName} 日志级别已重置为默认`)
        }
      }
    }

    // 如果有模块日志级别变更，重新加载模块日志配置
    if (moduleLogLevelsChanged) {
      reloadModuleLogLevels()
    }
  }

  /**
   * 重新加载 .env 文件
   */
  reload(): boolean {
    try {
      // 重新加载 .env 文件到 process.env
      config({ path: this.envPath, override: true })
      this.loadConfig()
      return true
    } catch (error) {
      logger.error(`[ConfigManager] 重新加载配置失败: ${error}`)
      return false
    }
  }

  /**
   * 启动文件监听
   */
  startWatching(): void {
    if (this.isWatching) {
      logger.info('[ConfigManager] 已经在监听中，跳过')
      return
    }

    try {
      // 检查文件是否存在
      if (!fs.existsSync(this.envPath)) {
        logger.error(`[ConfigManager] 配置文件不存在: ${this.envPath}`)
        return
      }

      fs.watchFile(this.envPath, { interval: 1000 }, (curr, prev) => {
        if (curr.mtime.getTime() !== prev.mtime.getTime()) {
          logger.info('[ConfigManager] 检测到 .env 文件变化，重新加载配置')
          this.reload()
        }
      })
      this.isWatching = true
      logger.info(`[ConfigManager] 开始监听配置文件: ${this.envPath}`)
    } catch (error) {
      logger.error(`[ConfigManager] 启动文件监听失败: ${error}`)
    }
  }

  /**
   * 停止文件监听
   */
  stopWatching(): void {
    if (!this.isWatching) return
    fs.unwatchFile(this.envPath)
    this.isWatching = false
    logger.info('[ConfigManager] 停止监听配置文件')
  }

  /**
   * 获取当前配置值
   */
  get<K extends keyof ReloadableConfig>(key: K): ReloadableConfig[K] {
    return this.currentConfig[key] as ReloadableConfig[K]
  }

  /**
   * 获取所有配置
   */
  getAll(): ReloadableConfig {
    return { ...this.currentConfig } as ReloadableConfig
  }
}

// 导出单例
export const configManager = new ConfigManager()
