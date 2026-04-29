/**
 * 工具审查判断模块
 * 提供统一的工具审查需求判断逻辑
 */

import { logger } from '../../utils/logger'
import { settingManager } from '../../config/setting-manager'

/**
 * 获取工具白名单
 * 从配置中心读取，支持运行时动态更新
 * @returns 白名单工具列表
 */
export function getToolWhitelist(): string[] {
  return settingManager.getToolReviewConfig().whitelist
}

/**
 * 检查工具是否需要审查
 * 白名单机制：只有白名单内的工具不需要审查，其他都需要
 * @param toolName 工具名称
 * @returns 是否需要审查
 */
export function requiresReview(toolName: string): boolean {
  // 从配置中心获取白名单（支持运行时更新）
  const whitelist = settingManager.getToolReviewConfig().whitelist

  // 调试日志
  logger.debug(`[requiresReview] 检查工具: ${toolName}, 白名单: ${JSON.stringify(whitelist)}`)

  // 检查是否在白名单中
  if (whitelist.includes(toolName)) {
    logger.debug(`[requiresReview] 工具 ${toolName} 在白名单中，不需要审查`)
    return false
  }

  // 不在白名单中的工具都需要审查
  logger.debug(`[requiresReview] 工具 ${toolName} 不在白名单中，需要审查`)
  return true
}
