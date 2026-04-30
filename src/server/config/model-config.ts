/**
 * 模型配置模块
 * 从 models 目录加载模型配置文件，支持热重载
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'events'
import { logger } from '../utils/logger'
import { debounce } from '../utils/watch-debounce'

export interface ModelConfig {
  [key: string]: unknown
}

function getModelsDir(): string {
  // 从工作空间加载 models 目录
  const workspacePath = process.env.WORKSPACE || process.cwd()
  return path.join(workspacePath, 'models')
}

function loadModelConfig(modelName: string): ModelConfig | null {
  const modelsDir = getModelsDir()
  const configPath = path.join(modelsDir, `${modelName}.json`)

  try {
    if (!fs.existsSync(configPath)) {
      logger.warn(`[ModelConfig] 模型配置文件不存在: ${configPath}`)
      return null
    }

    const content = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(content) as ModelConfig
  } catch (error) {
    logger.error(`[ModelConfig] 加载模型配置失败 ${modelName}: ${error}`)
    return null
  }
}

export class ModelConfigManager extends EventEmitter {
  private primaryModelName: string
  private fallbackNames: string[] = []
  private isWatching = false

  constructor(primaryModelName: string, fallbackNames: string[] = []) {
    super()
    this.primaryModelName = primaryModelName
    this.fallbackNames = fallbackNames
    logger.info(
      `[ModelConfig] 初始化，主模型: ${primaryModelName}, Fallbacks: ${fallbackNames.join(', ') || '无'}`,
    )
  }

  updateConfig(primaryModelName: string, fallbackNames: string[] = []): void {
    this.primaryModelName = primaryModelName
    this.fallbackNames = fallbackNames
    logger.info(
      `[ModelConfig] 配置已更新，主模型: ${primaryModelName}, Fallbacks: ${fallbackNames.join(', ') || '无'}`,
    )
    this.emit('configUpdate', primaryModelName, fallbackNames)
  }

  getPrimary(): ModelConfig | null {
    return loadModelConfig(this.primaryModelName)
  }

  getPrimaryName(): string {
    return this.primaryModelName
  }

  /**
   * 根据模型名称获取配置
   * @param modelName 模型名称（如 'MiniMax-M2.7-highspeed'）
   * @returns 模型配置，不存在返回 null
   */
  getByName(modelName: string): ModelConfig | null {
    return loadModelConfig(modelName)
  }

  getFallbacks(): ModelConfig[] {
    return this.fallbackNames
      .map((name) => loadModelConfig(name))
      .filter((config): config is ModelConfig => config !== null)
  }

  getFallbackNames(): string[] {
    return [...this.fallbackNames]
  }

  startWatching(): void {
    if (this.isWatching) return

    const modelsDir = getModelsDir()

    if (!fs.existsSync(modelsDir)) {
      logger.warn(`[ModelConfig] models 目录不存在: ${modelsDir}`)
      return
    }

    const allModelNames = [this.primaryModelName, ...this.fallbackNames]

    const debouncedReload = debounce((modelName: string) => {
      logger.info(`[ModelConfig] 检测到 ${modelName} 配置变化，重新加载`)
      const config = loadModelConfig(modelName)
      this.emit('modelConfigChange', modelName, config)
    }, { debounceMs: 500 })

    const watchFile = (modelName: string) => {
      const configPath = path.join(modelsDir, `${modelName}.json`)
      if (fs.existsSync(configPath)) {
        fs.watchFile(configPath, { interval: 1000 }, (curr, prev) => {
          if (curr.mtime.getTime() !== prev.mtime.getTime()) {
            debouncedReload(modelName)
          }
        })
      }
    }

    allModelNames.forEach(watchFile)
    this.isWatching = true
    logger.info(`[ModelConfig] 开始监听 models 目录: ${modelsDir}`)
  }

  stopWatching(): void {
    if (!this.isWatching) return

    const modelsDir = getModelsDir()
    const allModelNames = [this.primaryModelName, ...this.fallbackNames]

    allModelNames.forEach((modelName) => {
      const configPath = path.join(modelsDir, `${modelName}.json`)
      fs.unwatchFile(configPath)
    })

    this.isWatching = false
    logger.info('[ModelConfig] 停止监听 models 目录')
  }
}

let configManagerInstance: ModelConfigManager | null = null

export function initModelConfigManager(
  primaryModelName: string,
  fallbackNames: string[] = [],
): ModelConfigManager {
  if (configManagerInstance) {
    configManagerInstance.stopWatching()
  }
  configManagerInstance = new ModelConfigManager(primaryModelName, fallbackNames)
  configManagerInstance.startWatching()
  return configManagerInstance
}

export function getModelConfigManager(): ModelConfigManager | null {
  return configManagerInstance
}

export function reloadModelConfig(primaryModelName: string, fallbackNames: string[] = []): void {
  if (configManagerInstance) {
    configManagerInstance.stopWatching()
    configManagerInstance.updateConfig(primaryModelName, fallbackNames)
    configManagerInstance.startWatching()
  }
}
