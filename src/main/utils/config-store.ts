import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logger } from './logger'

/** 应用配置接口 */
export interface AppConfig {
  /** 目标屏幕ID，null表示使用副屏幕（默认行为） */
  targetDisplayId: number | null
}

/** 默认配置 */
const DEFAULT_CONFIG: AppConfig = {
  targetDisplayId: null,
}

/**
 * 获取配置文件路径
 * 使用应用用户数据目录
 */
function getConfigPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'app-config.json')
}

/**
 * 读取应用配置
 */
export function readConfig(): AppConfig {
  try {
    const configPath = getConfigPath()
    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG }
    }
    const content = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content)
    return { ...DEFAULT_CONFIG, ...config }
  } catch (error) {
    logger.error({ error }, '[ConfigStore] 读取配置失败')
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * 写入应用配置
 */
export function writeConfig(config: Partial<AppConfig>): void {
  try {
    const currentConfig = readConfig()
    const newConfig = { ...currentConfig, ...config }
    const configPath = getConfigPath()
    writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8')
    logger.info({ config: newConfig }, '[ConfigStore] 配置已保存')
  } catch (error) {
    logger.error({ error }, '[ConfigStore] 写入配置失败')
  }
}

/**
 * 获取目标屏幕ID
 */
export function getTargetDisplayId(): number | null {
  return readConfig().targetDisplayId
}

/**
 * 设置目标屏幕ID
 */
export function setTargetDisplayId(displayId: number | null): void {
  writeConfig({ targetDisplayId: displayId })
}
