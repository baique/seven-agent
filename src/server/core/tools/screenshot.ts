import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../utils/logger'
import { nanoid } from 'nanoid'
import { getHybridServer } from '../../socket'
import { env } from '../../config/env'
import type { WebSocket } from 'ws'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

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

    // 使用 command 字段而不是 type 字段，以符合 SocketServer 的消息格式
    socket.send(
      JSON.stringify({
        command: 'screenshot:request',
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
返回文本描述，包含截图尺寸、格式和访问链接，LLM 应根据描述向用户说明屏幕状态。`,
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

      const baseUrl = env.SCREENSHOT_BASE_URL
      if (!baseUrl) {
        return '截图失败：未配置 SCREENSHOT_BASE_URL'
      }

      // 将 base64 写入临时文件
      const ext = format === 'png' ? 'png' : 'jpg'
      const tmpFile = path.join(tmpdir(), `screenshot-${nanoid(12)}.${ext}`)
      fs.writeFileSync(tmpFile, Buffer.from(result.base64, 'base64'))

      // 上传到云服务器
      const uploadUrl = `${baseUrl.replace(/\/+$/, '')}/upload`
      const fileBuffer = fs.readFileSync(tmpFile)
      const boundary = `----FormBoundary${nanoid(16)}`
      const filename = path.basename(tmpFile)
      const mimeType = ext === 'jpg' ? 'image/jpeg' : 'image/png'

      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        ),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])

      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      })
      const uploadJson = (await uploadRes.json()) as {
        filename?: string
        url?: string
        error?: string
      }

      // 清理临时文件
      fs.unlink(tmpFile, () => {})

      if (!uploadRes.ok || uploadJson.error) {
        logger.error(`[screenshot] 上传失败: ${uploadJson.error || uploadRes.status}`)
        return `截图上传失败：${uploadJson.error || `HTTP ${uploadRes.status}`}`
      }

      const publicUrl = `${baseUrl.replace(/\/+$/, '')}/files/${uploadJson.filename}`
      logger.info(`[screenshot] 截图成功: ${result.width}x${result.height}, 上传至 ${publicUrl}`)

      // 返回 OpenAI 标准的多模态格式
      return [
        {
          type: 'image_url',
          image_url: {
            url: publicUrl,
          },
        },
      ]
    } catch (error: any) {
      logger.error(`[screenshot] 截图失败: ${error.message}`)
      return `截图失败：${error.message}`
    }
  },
})
