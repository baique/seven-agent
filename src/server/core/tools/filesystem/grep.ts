import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'
import { rgPath } from '@vscode/ripgrep'

const execFileAsync = promisify(execFile)

/**
 * Grep工具Schema - 对齐Claude Code标准
 */
const grepSchema = z.object({
  path: z.string().describe('搜索的根目录绝对路径'),
  pattern: z
    .union([z.string(), z.array(z.string())])
    .describe('搜索模式，支持正则表达式或正则数组（OR关系）'),
  glob: z.string().optional().describe('文件名过滤模式，如 *.ts, **/*.vue'),
  type: z.string().optional().describe('文件类型过滤，如 js, py, rust（优先于glob）'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .default('files_with_matches')
    .describe(
      '输出模式：content=显示匹配内容, files_with_matches=仅显示文件路径(默认), count=显示匹配次数',
    ),
  head_limit: z.number().optional().default(100).describe('限制输出结果数，默认 100'),
  '-A': z.number().optional().describe('匹配行后显示的行数'),
  '-B': z.number().optional().describe('匹配行前显示的行数'),
  '-C': z.number().optional().default(2).describe('匹配行上下文行数，默认 2'),
  '-n': z.boolean().optional().default(true).describe('是否显示行号，默认 true'),
  multiline: z.boolean().optional().default(false).describe('是否启用多行匹配模式，默认 false'),
  exclude: z
    .array(z.string())
    .optional()
    .default(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target', '.next'])
    .describe('要排除的目录'),
})

type GrepParams = z.infer<typeof grepSchema>

/**
 * 获取 ripgrep 二进制路径
 * @returns ripgrep 可执行文件的完整路径
 */
function getRipgrepPath(): string {
  return rgPath
}

/**
 * 使用ripgrep执行搜索
 */
async function searchWithRipgrep(
  searchPath: string,
  params: GrepParams,
): Promise<{
  files: string[]
  matches: Array<{ path: string; line: number; text: string; context: string }>
}> {
  const {
    pattern,
    glob,
    type,
    output_mode,
    head_limit,
    '-A': afterLines,
    '-B': beforeLines,
    '-C': contextLines = 2,
    '-n': showLineNumbers = true,
    multiline,
    exclude,
  } = params

  const args: string[] = []

  // 添加排除目录 - 使用 --glob 排除
  for (const dir of exclude) {
    args.push('-g', `!${dir}`)
    args.push('-g', `!**/${dir}/**`)
  }

  // 添加文件类型过滤（ripgrep 内置支持：js, ts, py, rust, go, java, cpp, c, 等）
  if (type) {
    args.push('-t', type)
  }

  // 添加 glob 过滤
  if (glob) {
    args.push('-g', glob)
  }

  // 添加上下文行（优先使用 -A/-B，如果没有则使用 -C）
  if (output_mode === 'content') {
    if (afterLines !== undefined || beforeLines !== undefined) {
      if (afterLines !== undefined) {
        args.push('-A', String(afterLines))
      }
      if (beforeLines !== undefined) {
        args.push('-B', String(beforeLines))
      }
    } else {
      args.push('-C', String(contextLines))
    }
  }

  // 显示行号
  if (showLineNumbers) {
    args.push('-n')
  }

  // 多行模式
  if (multiline) {
    args.push('-U')
  }

  // 输出模式
  if (output_mode === 'files_with_matches') {
    args.push('-l')
  } else if (output_mode === 'count') {
    args.push('-c')
  }

  // 限制结果数
  args.push('-m', String(head_limit))

  // 添加搜索模式
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  if (patterns.length > 1) {
    args.push('-e', patterns[0])
    for (let i = 1; i < patterns.length; i++) {
      args.push('-e', patterns[i])
    }
  } else {
    args.push('-e', patterns[0])
  }

  // 搜索路径
  args.push(searchPath)

  const rgExecutablePath = getRipgrepPath()
  logger.info(`[grep] ripgrep 命令：${rgExecutablePath} ${args.join(' ')}`)

  const { stdout } = await execFileAsync(rgExecutablePath, args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })

  const files: string[] = []
  const matches: Array<{ path: string; line: number; text: string; context: string }> = []

  if (output_mode === 'files_with_matches') {
    const lines = stdout.split('\n').filter((line) => line.trim())
    for (const line of lines) {
      const relativePath = path.relative(searchPath, line)
      if (relativePath && !files.includes(relativePath)) {
        files.push(relativePath)
      }
    }
  } else if (output_mode === 'count') {
    const lines = stdout.split('\n').filter((line) => line.trim())
    for (const line of lines) {
      const colonIndex = line.lastIndexOf(':')
      if (colonIndex > 0) {
        const filePath = line.slice(0, colonIndex)
        const relativePath = path.relative(searchPath, filePath)
        if (relativePath && !files.includes(relativePath)) {
          files.push(relativePath)
        }
      }
    }
  } else {
    // content模式
    const lines = stdout.split('\n')
    let currentMatch: { path: string; line: number; text: string; contextLines: string[] } | null =
      null

    for (const line of lines) {
      const match = line.match(/^(.+?)([:-])(\d+)([:-])(.*)$/)
      if (match) {
        const [, filePath, separator1, lineNumStr, , text] = match
        const lineNum = parseInt(lineNumStr, 10)
        const isMatchLine = separator1 === ':'
        const relativePath = path.relative(searchPath, filePath)

        if (isMatchLine) {
          if (currentMatch) {
            matches.push({
              path: currentMatch.path,
              line: currentMatch.line,
              text: currentMatch.text,
              context: currentMatch.contextLines.join('\n'),
            })
          }
          currentMatch = {
            path: relativePath,
            line: lineNum,
            text: text.trim(),
            contextLines: [`${showLineNumbers ? `${lineNum}: ` : ''}${text}`],
          }
          if (!files.includes(relativePath)) {
            files.push(relativePath)
          }
        } else if (currentMatch && currentMatch.path === relativePath) {
          currentMatch.contextLines.push(`${showLineNumbers ? `${lineNum}: ` : ''}${text}`)
        }
      }
    }

    if (currentMatch) {
      matches.push({
        path: currentMatch.path,
        line: currentMatch.line,
        text: currentMatch.text,
        context: currentMatch.contextLines.join('\n'),
      })
    }
  }

  return { files, matches }
}

/**
 * Grep 工具 - 使用@vscode/ripgrep 实现
 */
export const grepTool = new DynamicStructuredTool({
  name: 'grep',
  description: `A powerful search tool built on ripgrep

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) — literal braces need escaping (use \`interface\\{\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\``,
  schema: grepSchema,
  func: async (params: GrepParams) => {
    const {
      path: searchPath,
      pattern,
      output_mode = 'files_with_matches',
      head_limit = 100,
    } = params

    logger.info(`[grep] 搜索: ${searchPath}, 模式: ${pattern}`)

    const toolName = 'grep'

    const pathValidation = validatePath(searchPath)
    if (!pathValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: pathValidation.error!,
        extra: { errorType: pathValidation.errorType },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      logger.info('[grep] 使用@vscode/ripgrep 进行搜索')
      const result = await searchWithRipgrep(resolvedPath, params)
      const files = result.files
      const matches = result.matches

      const truncated = files.length >= head_limit

      if (output_mode === 'files_with_matches') {
        const body = files.slice(0, head_limit).join('\n')
        return await ToolResult.success(toolName, {
          msg: `找到 ${Math.min(files.length, head_limit)} 个文件${truncated ? '（已截断）' : ''}，模式: ${pattern}`,
          body: body || '无匹配结果',
          extra: {
            path: resolvedPath,
            pattern,
            count: files.length,
            truncated,
          },
        })
      }

      if (output_mode === 'count') {
        return await ToolResult.success(toolName, {
          msg: `共 ${files.length} 个文件匹配，模式: ${pattern}${truncated ? '（已截断）' : ''}`,
          body: files.join('\n') || '无匹配结果',
          extra: {
            path: resolvedPath,
            pattern,
            fileCount: files.length,
            truncated,
          },
        })
      }

      const fileMatches = new Map<string, typeof matches>()
      for (const match of matches.slice(0, head_limit)) {
        if (!fileMatches.has(match.path)) {
          fileMatches.set(match.path, [])
        }
        fileMatches.get(match.path)!.push(match)
      }

      const output = Array.from(fileMatches.entries())
        .map(([filePath, fileMatches]) => {
          const matchesText = fileMatches
            .map((m) => `行${m.line}: ${m.text}\n${m.context}`)
            .join('\n---\n')
          return `## ${filePath}\n${matchesText}`
        })
        .join('\n\n')

      return await ToolResult.success(toolName, {
        msg: `找到 ${matches.length} 个匹配${truncated ? '（已截断）' : ''}，模式: ${pattern}`,
        body: output || '无匹配结果',
        extra: {
          path: resolvedPath,
          pattern,
          count: matches.length,
          truncated,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[grep] 执行失败: ${errorMsg}`)

      if (errorMsg.includes('No such file or directory') || errorMsg.includes('ENOENT')) {
        return await ToolResult.error(toolName, {
          msg: '目录不存在',
          extra: { errorType: 'not_found' },
        })
      }

      return await ToolResult.error(toolName, {
        msg: errorMsg,
        extra: { errorType: 'unknown' },
      })
    }
  },
})
