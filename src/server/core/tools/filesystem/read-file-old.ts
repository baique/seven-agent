import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import iconv from 'iconv-lite'
import { configManager } from '../../../config/env'
import { logger } from '../../../utils/logger'
import { validatePath, getFileType } from '../../../utils/path-policy'
import { detectAndDecode } from '../../../utils/encoding-utils'
import { ToolResult } from '../../../utils/tool-response'
import { ContentAccumulator } from '../../../utils/content-accumulator'

const BUFFER_SIZE = 64 * 1024

function getReadFileSchema() {
  return z.object({
    file_path: z.string().describe('文件绝对路径'),
    offset: z.number().min(1).default(1).describe('起始行号'),
    limit: z
      .number()
      .min(1)
      .max(configManager.get('FILE_READ_MAX_LINES'))
      .default(configManager.get('FILE_READ_DEFAULT_LIMIT'))
      .describe('读取行数'),
    encoding: z.string().optional().describe('文件编码'),
  })
}

type ReadFileParams = z.infer<ReturnType<typeof getReadFileSchema>>

interface ReadResult {
  lines: { lineNumber: number; content: string }[]
  totalLines: number
  readLines: number
  truncated: boolean
  truncatedReason?: 'chars' | 'lines'
  streamEnded: boolean
  hasLongLine?: boolean
  longLineNumber?: number
}

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

function formatLineNumber(lineNumber: number, maxWidth: number): string {
  return String(lineNumber).padStart(maxWidth, '0') + '| '
}

async function readFileWithLimit(
  file_path: string,
  offset: number,
  limit: number,
  encoding?: string,
): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(file_path, { highWaterMark: BUFFER_SIZE })

    let totalLines = 0
    let currentLine = 0
    const selectedLines: { lineNumber: number; content: string }[] = []
    let truncated = false
    let truncatedReason: 'chars' | 'lines' | undefined
    let resolved = false
    let hasLongLine = false
    let longLineNumber = 0

    const accumulator = new ContentAccumulator()

    const doResolve = (result: ReadResult) => {
      if (!resolved) {
        resolved = true
        resolve(result)
      }
    }

    stream.on('data', (chunk) => {
      if (truncated) return

      chunks.push(chunk as Buffer)

      const content = decodeBuffer(Buffer.concat(chunks), encoding)
      const allLines = content.split('\n')

      if (allLines.length > 1) {
        const completeLines = allLines.slice(0, -1)
        chunks.length = 0
        const lastLine = allLines[allLines.length - 1]
        chunks.push(Buffer.from(lastLine, (encoding || 'utf-8') as BufferEncoding))

        for (const line of completeLines) {
          totalLines++

          if (currentLine >= offset - 1 && currentLine < offset - 1 + limit) {
            const lineText = line + '\n'

            const charsWouldExceed =
              accumulator.getCharCount() + lineText.length > accumulator.getMaxChars()
            const linesWouldExceed = accumulator.getLineCount() + 1 > accumulator.getMaxLines()
            const wouldExceed = charsWouldExceed || linesWouldExceed

            if (wouldExceed) {
              truncated = true

              if (charsWouldExceed) {
                if (line.length > accumulator.getMaxChars()) {
                  truncatedReason = 'chars'
                  hasLongLine = true
                  longLineNumber = totalLines
                  const remainingChars = accumulator.getMaxChars() - accumulator.getCharCount()
                  if (remainingChars > 0) {
                    accumulator.append(line.substring(0, remainingChars))
                    selectedLines.push({
                      lineNumber: totalLines,
                      content: line.substring(0, remainingChars),
                    })
                  }
                } else {
                  truncatedReason = 'chars'
                }
              } else {
                truncatedReason = 'lines'
              }
              break
            }

            accumulator.append(lineText)
            selectedLines.push({ lineNumber: totalLines, content: line })
          }

          currentLine++

          if (currentLine >= offset - 1 + limit) {
            truncated = true
            truncatedReason = undefined
            break
          }
        }

        if (truncated) {
          stream.destroy()
          doResolve({
            lines: selectedLines,
            totalLines,
            readLines: selectedLines.length,
            truncated: truncatedReason !== undefined,
            truncatedReason,
            streamEnded: false,
            hasLongLine,
            longLineNumber: hasLongLine ? longLineNumber : undefined,
          })
        }
      }
    })

    stream.on('end', () => {
      if (resolved) return

      if (chunks.length > 0) {
        const remainingContent = decodeBuffer(Buffer.concat(chunks), encoding)
        if (remainingContent) {
          const remainingLines = remainingContent.split('\n')
          for (const line of remainingLines) {
            totalLines++

            if (currentLine >= offset - 1 && currentLine < offset - 1 + limit) {
              const lineText = line + '\n'

              const charsWouldExceed =
                accumulator.getCharCount() + lineText.length > accumulator.getMaxChars()
              const linesWouldExceed = accumulator.getLineCount() + 1 > accumulator.getMaxLines()
              const wouldExceed = charsWouldExceed || linesWouldExceed

              if (wouldExceed) {
                truncated = true

                if (charsWouldExceed) {
                  if (line.length > accumulator.getMaxChars()) {
                    truncatedReason = 'chars'
                    hasLongLine = true
                    longLineNumber = totalLines
                    const remainingChars = accumulator.getMaxChars() - accumulator.getCharCount()
                    if (remainingChars > 0) {
                      accumulator.append(line.substring(0, remainingChars))
                      selectedLines.push({
                        lineNumber: totalLines,
                        content: line.substring(0, remainingChars),
                      })
                    }
                  } else {
                    truncatedReason = 'chars'
                  }
                } else {
                  truncatedReason = 'lines'
                }
                break
              }

              accumulator.append(lineText)
              selectedLines.push({ lineNumber: totalLines, content: line })
            }

            currentLine++
          }
        }
      }

      doResolve({
        lines: selectedLines,
        totalLines,
        readLines: selectedLines.length,
        truncated: false,
        truncatedReason: undefined,
        streamEnded: true,
        hasLongLine,
        longLineNumber: hasLongLine ? longLineNumber : undefined,
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

export const readFileContent = async (params: ReadFileParams) => {
  const {
    file_path,
    offset = 1,
    limit = configManager.get('FILE_READ_DEFAULT_LIMIT'),
    encoding,
  } = params
  const toolName = 'read_file'

  logger.info(`[${toolName}] 读取文件: ${file_path}, offset: ${offset}, limit: ${limit}`)

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

    const result = await readFileWithLimit(resolvedPath, offset, limit, encoding)
    const {
      lines,
      totalLines,
      readLines,
      truncated,
      truncatedReason,
      streamEnded,
      hasLongLine,
      longLineNumber,
    } = result

    const actualEndLine = offset + readLines - 1
    const hasMore = !streamEnded || truncated
    const nextOffset = actualEndLine + 1

    let msg = `文件共 ${totalLines} 行，已读取 ${offset}-${actualEndLine} 行`
    if (truncated) {
      msg += `（因${truncatedReason === 'chars' ? '字符数' : '行数'}超限截断）`
    }

    const lineNumberWidth = String(totalLines).length
    const formattedLines = lines.map(
      (line) => formatLineNumber(line.lineNumber, lineNumberWidth) + line.content,
    )
    let body = formattedLines.join('\n')

    if (hasMore) {
      body += `\n\n--- 数据过长，请继续读取下一页（offset: ${nextOffset}）---`
    }

    if (hasLongLine && longLineNumber) {
      body += `\n\n--- 注意：第 ${longLineNumber} 行内容过长（超过 ${configManager.get('FILE_READ_MAX_CHARS')} 字符），建议使用 read_line 工具读取该行 ---`
    }

    return await ToolResult.success(toolName, {
      msg,
      body,
      extra: {
        totalLines,
        readLines,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? nextOffset : undefined,
        truncated,
        truncatedReason,
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
}

export const readFileTool = new DynamicStructuredTool({
  name: 'read_file',
  description: `读取文件内容，支持分页读取大文件。
返回格式：JSON元数据 + 分隔线 + 文件内容（带行号）。
如内容过长会自动截断并提示继续读取方式。`,
  schema: getReadFileSchema(),
  func: async (input) => {
    return await readFileContent(input)
  },
})
