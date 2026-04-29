import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
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
    mode: z.enum(['head', 'tail']).default('head').describe('读取模式：head从开头读，tail从末尾读'),
  })
}

type ReadFileParams = z.infer<ReturnType<typeof getReadFileSchema>>

interface LineInfo {
  lineNumber: number
  content: string
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

async function headReader(
  file_path: string,
  offset: number,
  limit: number,
  onLine: (relativeLineNum: number, content: string) => boolean,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let currentLine = 0
    let readCount = 0
    let resolved = false

    const stream = createReadStream(file_path, { highWaterMark: BUFFER_SIZE })
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    const doResolve = (completed: boolean) => {
      if (!resolved) {
        resolved = true
        stream.destroy()
        rl.close()
        resolve(completed)
      }
    }

    rl.on('line', (line) => {
      if (resolved) return

      currentLine++

      if (currentLine < offset) {
        return
      }

      readCount++
      if (readCount > limit) {
        doResolve(false)
        return
      }

      const shouldContinue = onLine(currentLine, line)
      if (!shouldContinue) {
        doResolve(false)
      }
    })

    rl.on('close', () => doResolve(true))
    rl.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })
    stream.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })
  })
}

async function tailReader(
  file_path: string,
  offset: number,
  limit: number,
  encoding?: string,
  onLine?: (relativeLineNum: number, content: string) => boolean,
): Promise<boolean> {
  const stats = await stat(file_path)
  const fileSize = stats.size

  const estimatedBytesPerLine = 100
  const linesToRead = offset + limit - 1
  let bytesToRead = Math.min(linesToRead * estimatedBytesPerLine, fileSize)

  let buffer = Buffer.alloc(0)
  let position = fileSize

  while (position > 0 && bytesToRead > 0) {
    const readSize = Math.min(bytesToRead, BUFFER_SIZE)
    position -= readSize

    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = createReadStream(file_path, {
        start: position,
        end: position + readSize - 1,
      })
      stream.on('data', (data) => chunks.push(data as Buffer))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })

    buffer = Buffer.concat([chunk, buffer])

    let content: string
    try {
      if (encoding) {
        const normalizedEncoding = encoding.toLowerCase().replace(/[-_]/g, '')
        if (normalizedEncoding === 'gbk' || normalizedEncoding === 'cp936') {
          content = iconv.decode(buffer, 'gbk')
        } else {
          content = buffer.toString(encoding as BufferEncoding)
        }
      } else {
        content = detectAndDecode(buffer)
      }
    } catch {
      bytesToRead += readSize
      continue
    }

    const lines = content.split('\n')
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }

    if (lines.length >= linesToRead) {
      const startIdx = Math.max(0, lines.length - linesToRead)
      const selectedLines = lines.slice(startIdx, startIdx + limit)

      for (let i = 0; i < selectedLines.length; i++) {
        const lineNumber = offset + i
        const shouldContinue = onLine ? onLine(lineNumber, selectedLines[i]) : true
        if (!shouldContinue) {
          return false
        }
      }
      return true
    }

    bytesToRead += readSize
  }

  let content: string
  try {
    if (encoding) {
      const normalizedEncoding = encoding.toLowerCase().replace(/[-_]/g, '')
      if (normalizedEncoding === 'gbk' || normalizedEncoding === 'cp936') {
        content = iconv.decode(buffer, 'gbk')
      } else {
        content = buffer.toString(encoding as BufferEncoding)
      }
    } else {
      content = detectAndDecode(buffer)
    }
  } catch {
    content = buffer.toString('utf-8')
  }

  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  const selectedLines = lines.slice(0, limit)
  for (let i = 0; i < selectedLines.length; i++) {
    const lineNumber = offset + i
    const shouldContinue = onLine ? onLine(lineNumber, selectedLines[i]) : true
    if (!shouldContinue) {
      return false
    }
  }

  return true
}

export const readFileContent = async (params: ReadFileParams) => {
  const {
    file_path,
    offset = 1,
    limit = configManager.get('FILE_READ_DEFAULT_LIMIT'),
    encoding,
    mode = 'head',
  } = params
  const toolName = 'read_file'

  logger.info(
    `[${toolName}] 读取文件: ${file_path}, mode: ${mode}, offset: ${offset}, limit: ${limit}`,
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

    const accumulator = new ContentAccumulator()
    const lines: LineInfo[] = []
    let truncated = false
    let truncatedReason: 'chars' | 'lines' | undefined
    let hasLongLine = false
    let longLineNumber = 0
    let lastLineNumber = 0

    const onLine = (relativeLineNum: number, content: string): boolean => {
      lastLineNumber = relativeLineNum
      const lineText = content + '\n'

      const charsWouldExceed =
        accumulator.getCharCount() + lineText.length > accumulator.getMaxChars()
      const linesWouldExceed = accumulator.getLineCount() + 1 > accumulator.getMaxLines()

      if (charsWouldExceed || linesWouldExceed) {
        truncated = true

        if (charsWouldExceed && content.length > accumulator.getMaxChars()) {
          truncatedReason = 'chars'
          hasLongLine = true
          longLineNumber = relativeLineNum
          const remainingChars = accumulator.getMaxChars() - accumulator.getCharCount()
          if (remainingChars > 0) {
            lines.push({
              lineNumber: relativeLineNum,
              content: content.substring(0, remainingChars),
            })
          }
        } else {
          truncatedReason = charsWouldExceed ? 'chars' : 'lines'
        }

        return false
      }

      accumulator.append(lineText)
      lines.push({ lineNumber: relativeLineNum, content })
      return true
    }

    const streamEnded =
      mode === 'tail'
        ? await tailReader(resolvedPath, offset, limit, encoding, onLine)
        : await headReader(resolvedPath, offset, limit, onLine)
    const readLines = lines.length
    const actualEndLine = readLines > 0 ? lines[lines.length - 1].lineNumber : offset - 1
    const hasMore = mode === 'head' && (!streamEnded || truncated)
    const nextOffset = actualEndLine + 1

    let msg =
      mode === 'tail'
        ? `已读取倒数第 ${offset}-${offset + readLines - 1} 行`
        : `已读取第 ${offset}-${actualEndLine} 行`

    if (truncated) {
      msg += `（因${truncatedReason === 'chars' ? '字符数' : '行数'}超限截断）`
    }

    const lineNumberWidth = 3
    const formattedLines = lines.map(
      (line) => formatLineNumber(line.lineNumber, lineNumberWidth) + line.content,
    )
    let body = formattedLines.join('\n')

    if (hasMore) {
      body += `\n\n--- 数据过长，请使用工具继续读取下一页（offset: ${nextOffset}）---`
    }

    if (hasLongLine && longLineNumber) {
      body += `\n\n--- 注意：第 ${longLineNumber} 行内容过长（超过 ${configManager.get('FILE_READ_MAX_CHARS')} 字符），建议使用 read_line 工具读取该行 ---`
    }

    return await ToolResult.success(
      toolName,
      {
        msg,
        body,
        extra: {
          hasMore,
          truncated,
          truncatedReason,
        },
      },
      false,
    )
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
  description: `读取文件内容，支持分页读取大文件，支持 head/tail 两种模式。
head 模式：从文件开头开始读取（默认）
tail 模式：从文件末尾开始读取，适合查看日志文件最新内容
offset：相对偏移，head模式表示距离顶部多少行，tail模式表示距离底部多少行
行号：行号永远根据offset累加与模式无关（主要用于分页读取）
`,
  schema: getReadFileSchema(),
  func: async (input) => {
    return await readFileContent(input)
  },
})
