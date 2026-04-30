import pino from 'pino'
import fs from 'fs'
import path from 'path'

if (process.stdout && typeof process.stdout.setEncoding === 'function') {
  process.stdout.setEncoding('utf8')
}
if (process.stderr && typeof process.stderr.setEncoding === 'function') {
  process.stderr.setEncoding('utf8')
}

const isDebugMode = process.argv.includes('/debug')

/**
 * 日志文件配置
 */
const LOG_DIR = (() => {
  const workspacePath = process.env.WORKSPACE || process.cwd()
  return path.join(workspacePath, 'log')
})()
const MAX_DAYS = 7

/**
 * 获取当天的日志文件名
 */
function getTodayLogFile(): string {
  const today = new Date()
  const dateStr = today.toISOString().split('T')[0] // YYYY-MM-DD
  return path.join(LOG_DIR, `app-${dateStr}.log`)
}

/**
 * 模块日志级别配置
 * 键为模块名，值为日志级别
 */
const moduleLogLevels: Map<string, string> = new Map()

/**
 * 解析模块日志级别配置
 * 从环境变量中解析 LOG_LEVEL_<模块名> 格式的配置
 */
function parseModuleLogLevels(): void {
  moduleLogLevels.clear()
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LOG_LEVEL_') && key !== 'LOG_LEVEL' && value) {
      const moduleName = key.replace('LOG_LEVEL_', '').toLowerCase()
      moduleLogLevels.set(moduleName, value)
    }
  }
}

// 初始化解析模块日志级别
parseModuleLogLevels()

/**
 * 获取基础日志级别
 */
function getBaseLogLevel(): string {
  if (isDebugMode) return 'debug'
  return process.env.LOG_LEVEL || 'info'
}

/**
 * 初始化日志目录
 */
function initLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

/**
 * 清理7天前的日志文件
 */
function cleanupOldLogs(): void {
  const now = Date.now()
  const maxAge = MAX_DAYS * 24 * 60 * 60 * 1000

  try {
    const files = fs.readdirSync(LOG_DIR)
    for (const file of files) {
      if (file.startsWith('app-') && file.endsWith('.log')) {
        const filePath = path.join(LOG_DIR, file)
        try {
          const stats = fs.statSync(filePath)
          if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath)
          }
        } catch {
          // 单个文件读取失败，跳过
        }
      }
    }
  } catch {
    // 目录读取失败，静默跳过
  }
}

// 初始化日志目录和清理旧日志
initLogDir()
cleanupOldLogs()

// 全局日志级别，支持动态修改
let currentLogLevel = getBaseLogLevel()

/**
 * 创建 pino 日志实例
 * 支持控制台美化输出 + 按天分文件存储
 */
function createLogger() {
  const isDev = process.env.NODE_ENV !== 'production'

  // 获取当天的日志文件路径
  const todayLogFile = getTodayLogFile()

  // pino.destination 是原生支持的 API，用于写入文件
  const fileDest = pino.destination({
    dest: todayLogFile,
    sync: true,
  })

  const loggerConfig: pino.LoggerOptions = {
    level: currentLogLevel,
    base: null, // 简化日志格式
    serializers: {
      error: (e: unknown) => {
        if (e instanceof Error) {
          return {
            message: e.message,
            stack: e.stack,
            name: e.name,
            ...(e as Record<string, unknown>),
          }
        }
        return e
      },
    },
  }

  if (isDev) {
    // 开发模式：使用 pino-pretty 美化控制台，同时写入文件
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Pretty = require('pino-pretty')
    const prettyStream = Pretty({
      colorize: true,
      translateTime: 'SYS:standard',
      sync: true,
    })

    return pino(
      loggerConfig,
      pino.multistream([
        { stream: prettyStream, level: 'trace' },
        { stream: fileDest, level: 'trace' },
      ]),
    )
  } else {
    // 生产模式：仅写入文件
    return pino(loggerConfig, fileDest)
  }
}

// 创建 logger 实例
let loggerInstance = createLogger()

/**
 * 重新创建 logger 实例（用于配置变更后）
 */
function recreateLogger(): void {
  const newLevel = getBaseLogLevel()
  if (newLevel !== currentLogLevel) {
    currentLogLevel = newLevel
    loggerInstance = createLogger()
  }
}

/**
 * 代理对象，支持动态级别调整
 */
export const logger = new Proxy({} as pino.Logger, {
  get(target, prop) {
    // 每次访问时检查是否需要重新创建 logger
    recreateLogger()
    return (loggerInstance as Record<string, unknown>)[prop as string]
  },
})

/**
 * 同步日志级别与环境变量
 * 在配置加载完成后调用，确保 LOG_LEVEL 环境变量生效
 */
export function syncLogLevelWithEnv(): void {
  const envLevel = process.env.LOG_LEVEL
  if (envLevel && envLevel !== currentLogLevel) {
    currentLogLevel = envLevel
    loggerInstance = createLogger()
  }
}

/**
 * 设置全局日志级别
 * @param level 日志级别
 */
export function setLogLevel(level: string): void {
  currentLogLevel = level
  loggerInstance = createLogger()
}

/**
 * 设置模块日志级别
 * @param moduleName 模块名
 * @param level 日志级别
 */
export function setModuleLogLevel(moduleName: string, level: string): void {
  moduleLogLevels.set(moduleName.toLowerCase(), level)
}

/**
 * 清除模块日志级别
 * @param moduleName 模块名
 */
export function clearModuleLogLevel(moduleName: string): void {
  moduleLogLevels.delete(moduleName.toLowerCase())
}

/**
 * 获取模块日志级别
 * @param moduleName 模块名
 * @returns 日志级别或 undefined
 */
export function getModuleLogLevel(moduleName: string): string | undefined {
  return moduleLogLevels.get(moduleName.toLowerCase())
}

/**
 * 获取所有模块日志级别配置
 * @returns 模块日志级别映射
 */
export function getAllModuleLogLevels(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, level] of moduleLogLevels) {
    result[name] = level
  }
  return result
}

/**
 * 重新加载模块日志级别配置
 * 从环境变量重新解析
 */
export function reloadModuleLogLevels(): void {
  parseModuleLogLevels()
}

/**
 * 检查是否为调试模式
 * @returns 是否为调试模式
 */
export function isDebug(): boolean {
  return currentLogLevel === 'debug'
}

/**
 * 手动触发日志清理
 */
export function triggerLogCleanup(): void {
  cleanupOldLogs()
}

/**
 * 获取日志目录路径
 */
export function getLogDirectory(): string {
  return LOG_DIR
}

/**
 * 检查模块是否启用指定日志级别
 * @param moduleName 模块名
 * @param level 日志级别
 * @returns 是否启用
 */
export function isLevelEnabled(moduleName: string, level: string): boolean {
  const moduleLevel = moduleLogLevels.get(moduleName.toLowerCase())
  const effectiveLevel = moduleLevel || currentLogLevel

  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
  const targetIndex = levels.indexOf(level)
  const currentIndex = levels.indexOf(effectiveLevel)

  if (targetIndex === -1 || currentIndex === -1) {
    return false
  }

  return targetIndex >= currentIndex
}

/**
 * 创建模块日志记录器
 * 支持模块级别的日志级别控制
 * @param moduleName 模块名
 * @returns 模块日志记录器
 */
export function createModuleLogger(moduleName: string) {
  const name = moduleName.toLowerCase()

  const shouldLog = (level: string): boolean => {
    return isLevelEnabled(name, level)
  }

  return {
    /**
     * 模块名
     */
    name,

    /**
     * 跟踪日志
     */
    trace: (msg: string) => {
      if (shouldLog('trace')) {
        logger.trace(`[${name}] ${msg}`)
      }
    },

    /**
     * 调试日志
     */
    debug: (msg: string) => {
      if (shouldLog('debug')) {
        logger.debug(`[${name}] ${msg}`)
      }
    },

    /**
     * 信息日志
     */
    info: (msg: string) => {
      if (shouldLog('info')) {
        logger.info(`[${name}] ${msg}`)
      }
    },

    /**
     * 警告日志
     */
    warn: (msg: string) => {
      if (shouldLog('warn')) {
        logger.warn(`[${name}] ${msg}`)
      }
    },

    /**
     * 错误日志
     */
    error: (msg: string) => {
      if (shouldLog('error')) {
        logger.error(`[${name}] ${msg}`)
      }
    },

    /**
     * 致命错误日志
     */
    fatal: (msg: string) => {
      if (shouldLog('fatal')) {
        logger.fatal(`[${name}] ${msg}`)
      }
    },

    /**
     * 检查是否启用指定日志级别
     */
    isLevelEnabled: (level: string) => shouldLog(level),
  }
}

/**
 * 模块日志记录器类型
 */
export type ModuleLogger = ReturnType<typeof createModuleLogger>
