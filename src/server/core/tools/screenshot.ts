import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../utils/logger'
import { nanoid } from 'nanoid'
import { getHybridServer } from '../../socket'
import type { WebSocket } from 'ws'

const screenshotSchema = z.object({
  displayId: z.number().optional().describe('指定截图的显示器ID，不传则截取主屏幕'),
  format: z
    .enum(['png', 'jpeg'])
    .optional()
    .default('jpeg')
    .describe('图片格式，默认jpeg（体积更小）'),
  quality: z
    .number()
    .min(30)
    .max(100)
    .optional()
    .default(75)
    .describe('JPEG质量(30-100)，默认75，仅对jpeg有效'),
})

function getUIConnection(): WebSocket | null {
  const server = getHybridServer()
  if (!server) return null
  const wss = server.getWSServer()
  if (!wss) return null
  for (const socket of wss.clients) {
    if (socket.readyState === 1) return socket
  }
  return null
}

function requestScreenshot(
  socket: WebSocket,
  displayId?: number,
): Promise<{ base64: string; format: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const requestId = `screenshot-${nanoid(12)}`
    const timeout = setTimeout(() => {
      reject(new Error('截图请求超时（15秒），请确认Electron前台正在运行'))
    }, 15000)

    const handler = (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        const msgType = msg.type || msg.command
        if (msgType === 'screenshot:result' && msg.requestId === requestId) {
          clearTimeout(timeout)
          socket.removeListener('message', handler)
          if (msg.data?.error) {
            reject(new Error(msg.data.error))
          } else if (msg.data?.success === false) {
            reject(new Error(msg.data.error || '截图失败'))
          } else {
            resolve(msg.data)
          }
        }
      } catch {
        // 非JSON消息，忽略
      }
    }

    socket.on('message', handler)

    socket.send(
      JSON.stringify({
        type: 'screenshot:request',
        requestId,
        data: { displayId },
        timestamp: Date.now(),
      }) + '\n',
    )
  })
}

export const screenshotTool = new DynamicStructuredTool({
  name: 'screenshot',
  description: `截取当前屏幕截图。

**使用场景：**
- 用户要求截图、看屏幕、看看桌面
- 需要了解用户当前屏幕状态时

**参数说明：**
- displayId: 可选，指定显示器ID（不传则截主屏幕）
- format: png 或 jpeg，默认 jpeg（体积更小）
- quality: JPEG质量 30-100，默认75

**返回格式：**
返回 OpenAI 标准格式的图片消息（image_url 类型），可直接展示给用户。`,
  schema: screenshotSchema,
  func: async ({ displayId, format, quality }) => {
    logger.info(
      `[screenshot] 请求截图: displayId=${displayId}, format=${format}, quality=${quality}`,
    )

    try {
      const socket = getUIConnection()
      if (!socket) {
        return '截图失败：没有可用的UI连接，请确认Electron前台正在运行'
      }

      const result = await requestScreenshot(socket, displayId)

      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
      const imageUrl = `data:${mimeType};base64,${result.base64}`

      logger.info(
        `[screenshot] 截图成功: ${result.width}x${result.height}, base64长度=${result.base64.length}`,
      )

      // 直接返回 data URL，模型可识别为图片
      return imageUrl
    } catch (error: any) {
      logger.error(`[screenshot] 截图失败: ${error.message}`)
      return `截图失败：${error.message}`
    }
  },
})
