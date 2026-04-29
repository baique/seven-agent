import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../utils/logger'
import os from 'node:os'
import { ToolResult } from '../../utils/tool-response'

const getSystemInfoSchema = z.object({})

export const getSystemInfoTool = new DynamicStructuredTool({
  name: 'get_system_info',
  description: '获取系统基本信息，包括CPU、内存、操作系统、网络等。用于了解当前运行环境的状态。',
  schema: getSystemInfoSchema,
  func: async () => {
    const toolName = 'get_system_info'
    logger.info('[get_system_info] 获取系统信息')

    const cpus = os.cpus()
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    const memoryUsagePercent = ((usedMemory / totalMemory) * 100).toFixed(2)

    const networkInterfaces = os.networkInterfaces()
    const ipAddresses: string[] = []
    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      if (interfaces) {
        for (const iface of interfaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            ipAddresses.push(`${name}: ${iface.address}`)
          }
        }
      }
    }

    const result = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      os: {
        type: os.type(),
        release: os.release(),
        version: os.version(),
        hostname: os.hostname(),
        uptime: os.uptime(),
        uptimeFormatted: formatUptime(os.uptime()),
      },
      cpu: {
        model: cpus[0]?.model || 'Unknown',
        cores: cpus.length,
        speed: cpus[0]?.speed || 0,
      },
      memory: {
        total: formatBytes(totalMemory),
        used: formatBytes(usedMemory),
        free: formatBytes(freeMemory),
        usagePercent: memoryUsagePercent,
      },
      network: {
        ipAddresses: ipAddresses.length > 0 ? ipAddresses : ['No external IP found'],
      },
      user: {
        username: os.userInfo().username,
        homedir: os.userInfo().homedir,
      },
    }

    logger.info('[get_system_info] 获取成功')
    const resultText = JSON.stringify(result, null, 2)
    return await ToolResult.success(toolName, {
      msg: '系统信息获取成功',
      body: resultText,
      extra: {
        platform: result.platform,
        arch: result.arch,
      },
    })
  },
})

const getCurrentTimeSchema = z.object({
  timezone: z.string().optional().describe('时区，例如 "Asia/Shanghai"，默认为本地时区'),
})

export const getCurrentTimeTool = new DynamicStructuredTool({
  name: 'get_current_time',
  description:
    '获取当前日期和时间。可以指定时区，默认为本地时区。用于了解当前时间、判断是否到饭点、提醒休息等。',
  schema: getCurrentTimeSchema,
  func: async ({ timezone }) => {
    const toolName = 'get_current_time'
    logger.info(`[get_current_time] 获取当前时间，时区：${timezone || '本地'}`)

    const now = new Date()
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone,
    }

    const formatter = new Intl.DateTimeFormat('zh-CN', options)
    const formatted = formatter.format(now)

    const result = {
      timestamp: now.getTime(),
      iso: now.toISOString(),
      formatted: formatted,
      timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      dayOfWeek: getDayOfWeek(now.getDay()),
      isWeekend: now.getDay() === 0 || now.getDay() === 6,
      hour: now.getHours(),
      isMorning: now.getHours() >= 6 && now.getHours() < 12,
      isNoon: now.getHours() >= 12 && now.getHours() < 14,
      isAfternoon: now.getHours() >= 14 && now.getHours() < 18,
      isEvening: now.getHours() >= 18 && now.getHours() < 22,
      isNight: now.getHours() >= 22 || now.getHours() < 6,
    }

    logger.info('[get_current_time] 获取成功')
    const resultText = JSON.stringify(result, null, 2)
    return await ToolResult.success(toolName, {
      msg: '当前时间获取成功',
      body: resultText,
      extra: {
        timestamp: result.timestamp,
        timezone: result.timezone,
      },
    })
  },
})

const getClipboardSchema = z.object({})

export const getClipboardTool = new DynamicStructuredTool({
  name: 'get_clipboard',
  description: '获取当前剪贴板中的内容。用于读取用户复制的文本信息。',
  schema: getClipboardSchema,
  func: async () => {
    const toolName = 'get_clipboard'
    logger.info('[get_clipboard] 获取剪贴板内容')

    try {
      const { clipboard } = await import('electron')
      const content = clipboard.readText()

      logger.info(`[get_clipboard] 获取成功，长度：${content.length}`)
      return await ToolResult.success(toolName, {
        msg: '剪贴板内容获取成功',
        body: content,
        extra: {
          length: content.length,
          isEmpty: content.length === 0,
        },
      })
    } catch (error: any) {
      logger.error(`[get_clipboard] 获取失败：${error.message}`)
      return await ToolResult.error(toolName, {
        msg: '无法访问剪贴板，可能不在 Electron 环境中',
        body: error.message,
      })
    }
  },
})

const setClipboardSchema = z.object({
  text: z.string().describe('要写入剪贴板的文本内容'),
})

export const setClipboardTool = new DynamicStructuredTool({
  name: 'set_clipboard',
  description: '将文本内容写入剪贴板。用于复制信息到剪贴板供用户使用。',
  schema: setClipboardSchema,
  func: async ({ text }) => {
    const toolName = 'set_clipboard'
    logger.info(`[set_clipboard] 写入剪贴板，长度：${text.length}`)

    try {
      const { clipboard } = await import('electron')
      clipboard.writeText(text)

      logger.info('[set_clipboard] 写入成功')
      return await ToolResult.success(toolName, {
        msg: '内容已写入剪贴板',
        extra: {
          length: text.length,
        },
      })
    } catch (error: any) {
      logger.error(`[set_clipboard] 写入失败：${error.message}`)
      return await ToolResult.error(toolName, {
        msg: '无法访问剪贴板，可能不在 Electron 环境中',
        body: error.message,
      })
    }
  },
})

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let size = bytes

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}小时`)
  if (minutes > 0) parts.push(`${minutes}分钟`)
  if (secs > 0) parts.push(`${secs}秒`)

  return parts.join('') || '0秒'
}

function getDayOfWeek(day: number): string {
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  return days[day]
}
