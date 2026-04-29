import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../utils/logger'
import { nanoid } from 'nanoid'
import { getHybridServer } from '../../socket'
import type { WebSocket } from 'ws'
import { ToolResult } from '../../utils/tool-response'

const openWindowSchema = z.object({
  popupType: z
    .enum(['notification', 'report'])
    .optional()
    .default('notification')
    .describe('弹窗类型：notification=简单通知(默认), report=报告展示'),
  content: z.string().describe('弹窗内容，支持HTML标签'),
  title: z.string().optional().describe('弹窗标题（可选）'),
  x: z.number().optional().default(-1).describe('弹窗X坐标，-1表示水平居中'),
  y: z.number().optional().default(-1).describe('弹窗Y坐标，-1表示垂直居中'),
  duration: z
    .number()
    .optional()
    .default(0)
    .describe('显示时长（毫秒），0表示不自动关闭，notification默认0，report默认0'),
  id: z.string().optional().describe('弹窗ID，用于替换已有弹窗内容'),
  continueProcessing: z
    .boolean()
    .optional()
    .default(true)
    .describe('发送成功后是否继续处理：true=继续让AI处理(回到llm节点)，false=直接存储并结束'),
})

function getUIConnection(): WebSocket | null {
  const server = getHybridServer()
  if (!server) {
    return null
  }
  const connections = server.getConnections()
  for (const socket of connections) {
    if (socket.readyState === 1) {
      return socket
    }
  }
  return null
}

export const openWindowTool = new DynamicStructuredTool({
  name: 'open_window',
  description: `以弹窗形式展示内容`,
  schema: openWindowSchema,
  func: async ({ popupType, content, title, x, y, duration, id, continueProcessing }) => {
    const toolName = 'open_window'
    const type = popupType ?? 'notification'
    logger.info(`[open_window] 发送${type}弹窗: ${content.slice(0, 50)}`)

    try {
      const defaultDuration = type === 'report' ? 0 : 5000

      const finalDuration = duration ?? defaultDuration
      const finalX = x ?? -1
      const finalY = y ?? -1

      const popupId = id || nanoid(16)

      const socket = getUIConnection()
      if (socket) {
        const message =
          JSON.stringify({
            code: 200,
            type: 'command:popup',
            data: {
              id: popupId,
              content,
              title: title || '通知',
              x: finalX,
              y: finalY,
              duration: finalDuration,
              popupType: type,
            },
            timestamp: Date.now(),
          }) + '\n'

        socket.send(message)
        logger.info(`[open_window] 已通过 Socket 发送弹窗创建命令: ${popupId}`)
      } else {
        logger.warn('[open_window] 没有可用的UI连接，无法发送弹窗命令')
      }

      return await ToolResult.success(toolName, {
        msg: '弹窗通知已发送',
        extra: {
          type,
          hasTitle: !!title,
          id: popupId,
          continueProcessing,
        },
      })
    } catch (error: any) {
      logger.error(`[open_window] 发送失败：${error.message}`)
      return await ToolResult.error(toolName, {
        msg: '发送弹窗通知时发生错误',
        body: error.message,
      })
    }
  },
})
