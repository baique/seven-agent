/**
 * 配置中心管理器
 * 管理 setting.json 配置文件的读写、热重载和变更通知
 */

import { EventEmitter } from 'events'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../utils/logger'
import { debounce } from '../utils/watch-debounce'

/** 截断模式 */
export type TrimMode = 'head' | 'tail' | 'summary' | 'structure'

/** 工具截断策略 */
export interface ToolTrimStrategy {
  /** 最大字符数 */
  maxChars?: number
  /** 最大行数 */
  maxLines?: number
  /** 截断模式 */
  mode?: TrimMode
}

/** 工具审查配置 */
export interface ToolReviewConfig {
  /** 白名单工具列表 - 这些工具不需要审查 */
  whitelist: string[]
}

/** 工具截断配置 */
export interface ToolTruncationConfig {
  /** 默认最大字符数 */
  defaultMaxChars: number
  /** 默认最大行数 */
  defaultMaxLines: number
  /** 默认截断模式 */
  defaultMode: TrimMode
  /** 按工具名称的特定策略 */
  strategies: Record<string, ToolTrimStrategy>
}

/** 配置中心完整配置 */
export interface SettingConfig {
  /** 工具审查配置 */
  toolReview: ToolReviewConfig
  /** 工具截断配置 */
  toolTruncation: ToolTruncationConfig
}

/** 默认工具白名单 */
const DEFAULT_TOOL_WHITELIST: string[] = [
  // 系统信息查看类
  'get_system_info',
  'get_current_time',
  'get_clipboard',
  // 文件系统查看类
  'read_file',
  'read_line',
  'list_directory',
  'get_file_info',
  'file_exists',
  'grep',
  // 记忆查看类
  'memory_search',
  'memory_deep_search',
  // 扩展工具查看类
  'ext_search',
  'ext_list',
  'ext_help',
  // 扩展工具执行（ext_invoke本身在白名单，内部MCP工具根据配置审查）
  'ext_invoke',
  // 子代理查看类
  'list_subagents',
  // 技能查看类
  'read_skill',
  // 会话笔记
  'get_session_notes',
  'update_session_notes',
  // 情绪更新
  'update_mood_values',
  // 记忆更新
  'update_memory',
  // 任务管理
  'create_tasks',
  'update_task',
  'list_tasks',
  'delete_task',
  'add_note',
  // 通知管理
  'open_window',
  'schedule_reminder',
  'query_reminders',
  'delete_reminder',
]

/** 默认工具截断策略 */
const DEFAULT_TOOL_TRUNCATION: ToolTruncationConfig = {
  defaultMaxChars: 10240,
  defaultMaxLines: 2000,
  defaultMode: 'head',
  strategies: {
    read_file: { maxChars: 10240, maxLines: 2000, mode: 'structure' },
    grep: { maxChars: 10240, maxLines: 2000, mode: 'structure' },
    terminal: { maxChars: 10240, maxLines: 2000, mode: 'tail' },
    memory_search: { maxChars: 5000, maxLines: 1000, mode: 'head' },
    memory_deep_search: { maxChars: 5000, maxLines: 1000, mode: 'head' },
    edit_file: { maxChars: 2000, maxLines: 500, mode: 'head' },
    screenshot: { maxChars: 2000, maxLines: 500, mode: 'head' },
  },
}

/** 获取默认配置 */
function getDefaultConfig(): SettingConfig {
  return {
    toolReview: {
      whitelist: [...DEFAULT_TOOL_WHITELIST],
    },
    toolTruncation: {
      defaultMaxChars: DEFAULT_TOOL_TRUNCATION.defaultMaxChars,
      defaultMaxLines: DEFAULT_TOOL_TRUNCATION.defaultMaxLines,
      defaultMode: DEFAULT_TOOL_TRUNCATION.defaultMode,
      strategies: { ...DEFAULT_TOOL_TRUNCATION.strategies },
    },
  }
}

/** 配置变更事件 */
export interface SettingChangeEvent {
  key: keyof SettingConfig
  oldValue: SettingConfig[keyof SettingConfig]
  newValue: SettingConfig[keyof SettingConfig]
}

/**
 * 配置中心管理器
 * 提供 setting.json 的读写、热重载和变更通知
 */

/**
 * 获取默认配置文件路径
 * 优先使用主进程通过环境变量传递的路径
 * 确保 Main 进程和 Server 进程使用同一配置文件
 */
function getDefaultSettingPath(): string {
  // 1. 优先使用主进程通过环境变量传递的路径
  if (process.env.SETTING_JSON_PATH) {
    logger.info(`[SettingManager] 使用环境变量指定的路径: ${process.env.SETTING_JSON_PATH}`)
    return process.env.SETTING_JSON_PATH
  }

  // 2. 尝试检测是否在打包环境
  const isPackaged = process.env.ELECTRON_IS_PACKAGED === 'true'

  if (isPackaged && process.env.RESOURCES_PATH) {
    const packagedPath = path.join(process.env.RESOURCES_PATH, 'setting.json')
    logger.info(`[SettingManager] 使用打包环境路径: ${packagedPath}`)
    return packagedPath
  }

  // 3. 尝试使用 electron app（仅在主进程中有效）
  try {
    const { app } = require('electron')
    if (app?.isPackaged) {
      return path.join(process.resourcesPath, 'setting.json')
    }
    return path.join(app?.getAppPath?.() || process.cwd(), 'setting.json')
  } catch {
    // 4. 回退到当前工作目录
    const cwdPath = path.join(process.cwd(), 'setting.json')
    logger.info(`[SettingManager] 使用当前工作目录路径: ${cwdPath}`)
    return cwdPath
  }
}

class SettingManager extends EventEmitter {
  private configPath: string
  private isWatching = false
  private currentConfig: SettingConfig = getDefaultConfig()

  constructor(configPath?: string) {
    super()
    this.configPath = configPath || getDefaultSettingPath()
    this.load()
  }

  /**
   * 设置配置文件路径（用于在主进程中重新初始化）
   */
  setConfigPath(configPath: string): void {
    if (this.configPath !== configPath) {
      this.stopWatching()
      this.configPath = configPath
      this.load()
    }
  }

  /**
   * 获取配置文件路径
   */
  getConfigPath(): string {
    return this.configPath
  }

  /**
   * 加载配置
   */
  load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8')
        const parsed = JSON.parse(content) as Partial<SettingConfig>
        this.currentConfig = this.mergeConfig(parsed)
        logger.info(`[SettingManager] 已加载配置文件: ${this.configPath}`)
      } else {
        this.currentConfig = getDefaultConfig()
        this.save()
        logger.info(`[SettingManager] 已创建默认配置文件: ${this.configPath}`)
      }
    } catch (error) {
      logger.error(`[SettingManager] 加载配置文件失败: ${error}`)
      this.currentConfig = getDefaultConfig()
    }
  }

  /**
   * 合并配置（使用默认值填充缺失项）
   */
  private mergeConfig(parsed: Partial<SettingConfig>): SettingConfig {
    const defaultConfig = getDefaultConfig()
    return {
      toolReview: {
        whitelist: parsed.toolReview?.whitelist ?? defaultConfig.toolReview.whitelist,
      },
      toolTruncation: {
        defaultMaxChars:
          parsed.toolTruncation?.defaultMaxChars ?? defaultConfig.toolTruncation.defaultMaxChars,
        defaultMaxLines:
          parsed.toolTruncation?.defaultMaxLines ?? defaultConfig.toolTruncation.defaultMaxLines,
        defaultMode: parsed.toolTruncation?.defaultMode ?? defaultConfig.toolTruncation.defaultMode,
        strategies: parsed.toolTruncation?.strategies ?? defaultConfig.toolTruncation.strategies,
      },
    }
  }

  /**
   * 保存配置到文件
   */
  save(): boolean {
    try {
      // 确保目录存在
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const content = JSON.stringify(this.currentConfig, null, 2)
      fs.writeFileSync(this.configPath, content, 'utf-8')
      logger.info(`[SettingManager] 已保存配置文件: ${this.configPath}`)
      return true
    } catch (error) {
      logger.error(`[SettingManager] 保存配置文件失败: ${error}`)
      return false
    }
  }

  /**
   * 启动文件监听（热重载）
   */
  startWatching(): void {
    if (this.isWatching) {
      logger.info('[SettingManager] 已经在监听中，跳过')
      return
    }

    try {
      // 文件不存在时自动创建
      if (!fs.existsSync(this.configPath)) {
        this.save()
      }

      const debouncedReload = debounce(
        () => {
          logger.info('[SettingManager] 检测到配置文件变化，重新加载')
          const oldConfig = { ...this.currentConfig }
          this.load()
          this.emit('change', { oldConfig, newConfig: this.currentConfig })
        },
        { debounceMs: 500 },
      )

      fs.watchFile(this.configPath, { interval: 1000 }, (curr, prev) => {
        if (curr.mtime.getTime() !== prev.mtime.getTime()) {
          debouncedReload()
        }
      })

      this.isWatching = true
      logger.info(`[SettingManager] 开始监听配置文件: ${this.configPath}`)
    } catch (error) {
      logger.error(`[SettingManager] 启动文件监听失败: ${error}`)
    }
  }

  /**
   * 停止文件监听
   */
  stopWatching(): void {
    if (!this.isWatching) return
    fs.unwatchFile(this.configPath)
    this.isWatching = false
    logger.info('[SettingManager] 停止监听配置文件')
  }

  /**
   * 获取完整配置
   */
  getConfig(): SettingConfig {
    return { ...this.currentConfig }
  }

  /**
   * 获取工具审查配置
   */
  getToolReviewConfig(): ToolReviewConfig {
    return { ...this.currentConfig.toolReview }
  }

  /**
   * 获取工具截断配置
   */
  getToolTruncationConfig(): ToolTruncationConfig {
    return {
      defaultMaxChars: this.currentConfig.toolTruncation.defaultMaxChars,
      defaultMaxLines: this.currentConfig.toolTruncation.defaultMaxLines,
      defaultMode: this.currentConfig.toolTruncation.defaultMode,
      strategies: { ...this.currentConfig.toolTruncation.strategies },
    }
  }

  /**
   * 更新工具审查白名单
   */
  setToolReviewWhitelist(whitelist: string[]): boolean {
    const oldValue = this.currentConfig.toolReview.whitelist
    this.currentConfig.toolReview.whitelist = [...whitelist]
    const saved = this.save()
    if (saved) {
      this.emit('change:toolReview', {
        key: 'toolReview',
        oldValue: { whitelist: oldValue },
        newValue: { whitelist: [...whitelist] },
      })
    }
    return saved
  }

  /**
   * 更新工具截断配置
   */
  setToolTruncationConfig(config: Partial<ToolTruncationConfig>): boolean {
    const oldValue = { ...this.currentConfig.toolTruncation }
    if (config.defaultMaxChars !== undefined) {
      this.currentConfig.toolTruncation.defaultMaxChars = config.defaultMaxChars
    }
    if (config.defaultMaxLines !== undefined) {
      this.currentConfig.toolTruncation.defaultMaxLines = config.defaultMaxLines
    }
    if (config.defaultMode !== undefined) {
      this.currentConfig.toolTruncation.defaultMode = config.defaultMode
    }
    if (config.strategies !== undefined) {
      this.currentConfig.toolTruncation.strategies = { ...config.strategies }
    }
    const saved = this.save()
    if (saved) {
      this.emit('change:toolTruncation', {
        key: 'toolTruncation',
        oldValue,
        newValue: { ...this.currentConfig.toolTruncation },
      })
    }
    return saved
  }

  /**
   * 更新特定工具的截断策略
   */
  setToolStrategy(toolName: string, strategy: ToolTrimStrategy): boolean {
    const oldValue = { ...this.currentConfig.toolTruncation.strategies }
    this.currentConfig.toolTruncation.strategies[toolName] = { ...strategy }
    const saved = this.save()
    if (saved) {
      this.emit('change:toolTruncation', {
        key: 'toolTruncation',
        oldValue: { strategies: oldValue },
        newValue: { strategies: { ...this.currentConfig.toolTruncation.strategies } },
      })
    }
    return saved
  }

  /**
   * 删除特定工具的截断策略
   */
  removeToolStrategy(toolName: string): boolean {
    const oldValue = { ...this.currentConfig.toolTruncation.strategies }
    delete this.currentConfig.toolTruncation.strategies[toolName]
    const saved = this.save()
    if (saved) {
      this.emit('change:toolTruncation', {
        key: 'toolTruncation',
        oldValue: { strategies: oldValue },
        newValue: { strategies: { ...this.currentConfig.toolTruncation.strategies } },
      })
    }
    return saved
  }
}

/** 配置中心管理器单例 */
export const settingManager = new SettingManager()
