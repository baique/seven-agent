import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import iconv from 'iconv-lite'
import { configManager } from '../../../config/env'
import { logger } from '../../../utils/logger'
import { validatePath, getFileType } from '../../../utils/path-policy'
import { detectAndDecode } from '../../../utils/encoding-utils'
import { ToolResult } from '../../../utils/tool-response'

const BUFFER_SIZE = 64 * 1024

/**
 * 读取单行 schema
 */
const readLineSchema = z.object({
  file_path: z.string().describe('文件绝对路径'),
  line_number: z.number().min(1).describe('要读取的行号'),
  offset: z.number().min(0).default(0).describe('行内偏移量（字符数）'),
  limit: z
    .number()
    .min(1)
    .max(configManager.get('FILE_READ_MAX_CHARS'))
    .default(configManager.get('FILE_READ_MAX_CHARS'))
    .describe('读取字符数，不能超过最大字符限制'),
  encoding: z.string().optional().describe('文件编码'),
})

type ReadLineParams = z.infer<typeof readLineSchema>

function decodeBuffer(buffer: Buffer, encoding?: string): string {
  if (encoding) {
    const normalizedEncoding = encoding.toLowerCase().replace(/[-_]/g, '')
    if (normalizedEncoding === 'gbk' || normalizedEncoding === 'cp936') {
      return iconv.decode(buffer, 'gbk')
    }
    return buffer.toString(encoding as BufferEncoding)
  }
  return detectAndDecode(buffer)
}

async function isBinaryFile(file_path: string): Promise<boolean> {
  const fileType = getFileType(file_path)
  if (fileType === 'binary') return true

  const handle = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(file_path, { highWaterMark: 8192 })
    stream.on('data', (chunk) => {
      chunks.push(chunk as Buffer)
      stream.destroy()
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    stream.on('close', () => resolve(Buffer.concat(chunks)))
  })

  for (let i = 0; i < Math.min(handle.length, 8192); i++) {
    const byte = handle[i]
    if (byte === 0) return true
  }

  return false
}

interface ReadLineResult {
  content: string
  totalLength: number
  hasMore: boolean
  nextOffset: number
}

async function readLineWithLimit(
  file_path: string,
  lineNumber: number,
  offset: number,
  limit: number,
  encoding?: string,
): Promise<ReadLineResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(file_path, { highWaterMark: BUFFER_SIZE })

    let currentLine = 0
    let targetLineContent = ''
    let found = false
    let resolved = false

    const doResolve = (result: ReadLineResult) => {
      if (!resolved) {
        resolved = true
        resolve(result)
      }
    }

    stream.on('data', (chunk) => {
      if (found) return

      chunks.push(chunk as Buffer)

      const content = decodeBuffer(Buffer.concat(chunks), encoding)
      const lines = content.split('\n')

      // 保留最后一行（可能不完整）
      if (lines.length > 1) {
        const completeLines = lines.slice(0, -1)
        chunks.length = 0
        const lastLine = lines[lines.length - 1]
        chunks.push(Buffer.from(lastLine, (encoding || 'utf-8') as BufferEncoding))

        for (const line of completeLines) {
          currentLine++
          if (currentLine === lineNumber) {
            targetLineContent = line
            found = true
            stream.destroy()

            // 计算返回内容
            const contentLength = targetLineContent.length
            const actualContent = targetLineContent.substring(offset, offset + limit)
            const hasMore = offset + actualContent.length < contentLength
            const nextOffset = offset + actualContent.length

            doResolve({
              content: actualContent,
              totalLength: contentLength,
              hasMore,
              nextOffset: hasMore ? nextOffset : contentLength,
            })
            return
          }
        }
      }
    })

    stream.on('end', () => {
      if (resolved) return

      // 处理最后一行
      if (chunks.length > 0 && !found) {
        const remainingContent = decodeBuffer(Buffer.concat(chunks), encoding)
        if (remainingContent) {
          currentLine++
          if (currentLine === lineNumber) {
            targetLineContent = remainingContent
            found = true

            const contentLength = targetLineContent.length
            const actualContent = targetLineContent.substring(offset, offset + limit)
            const hasMore = offset + actualContent.length < contentLength
            const nextOffset = offset + actualContent.length

            doResolve({
              content: actualContent,
              totalLength: contentLength,
              hasMore,
              nextOffset: hasMore ? nextOffset : contentLength,
            })
            return
          }
        }
      }

      // 未找到指定行
      doResolve({
        content: '',
        totalLength: 0,
        hasMore: false,
        nextOffset: 0,
      })
    })

    stream.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })
  })
}

/**
 * 读取单行工具
 * 用于读取文件中某一行的内容，支持行内分页
 */
export const readLineTool = new DynamicStructuredTool({
  name: 'read_line',
  description: `读取文件中指定行的内容，支持行内分页读取超长行。
返回格式：JSON元数据 + 分隔线 + 行内容。
如行内容过长会自动截断并提示继续读取方式。`,
  schema: readLineSchema,
  func: async (params: ReadLineParams) => {
    const { file_path, line_number, offset = 0, limit, encoding } = params
    const toolName = 'read_line'

    logger.info(
      `[${toolName}] 读取文件: ${file_path}, 行号: ${line_number}, offset: ${offset}, limit: ${limit}`,
    )

    const pathValidation = validatePath(file_path)
    if (!pathValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: pathValidation.error!,
        extra: { errorType: pathValidation.errorType },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      const stats = await stat(resolvedPath)
      if (!stats.isFile()) {
        return await ToolResult.error(toolName, {
          msg: '路径不是文件',
          extra: { errorType: 'not_file' },
        })
      }

      const isBinary = await isBinaryFile(resolvedPath)
      if (isBinary) {
        return await ToolResult.error(toolName, {
          msg: '文件是二进制格式，无法以文本方式读取',
          extra: { errorType: 'binary_file' },
        })
      }

      const result = await readLineWithLimit(resolvedPath, line_number, offset, limit, encoding)
      const { content, totalLength, hasMore, nextOffset } = result

      if (totalLength === 0) {
        return await ToolResult.error(toolName, {
          msg: `文件不存在第 ${line_number} 行`,
          extra: { errorType: 'line_not_found' },
        })
      }

      let msg = `第 ${line_number} 行共 ${totalLength} 字符`
      if (offset > 0 || content.length < totalLength) {
        msg += `，已读取 ${offset}-${offset + content.length} 字符`
        if (hasMore) {
          msg += '（已截断）'
        }
      }

      let body = content
      if (hasMore) {
        body += `\n\n--- 行内容过长，请使用工具继续读取（offset: ${nextOffset}）---`
      }

      return await ToolResult.success(toolName, {
        msg,
        body,
        extra: {
          lineNumber: line_number,
          totalLength,
          readLength: content.length,
          offset,
          limit,
          hasMore,
          nextOffset: hasMore ? nextOffset : undefined,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('ENOENT')) {
        msg = '文件不存在'
      } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        msg = '权限不足'
      }

      return await ToolResult.error(toolName, {
        msg,
        extra: {
          errorType: errorMsg.includes('ENOENT')
            ? 'not_found'
            : errorMsg.includes('EACCES') || errorMsg.includes('EPERM')
              ? 'permission_denied'
              : 'unknown',
        },
      })
    }
  },
})
