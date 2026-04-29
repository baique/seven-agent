import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat, readdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { logger } from '../../../utils/logger'
import { validatePath, formatBytes } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const listDirectorySchema = z.object({
  path: z.string().describe('要列出的目录绝对路径'),
  maxDepth: z.number().min(1).max(10).default(1).describe('最大递归层级，默认为1（仅当前目录）'),
  pattern: z.string().optional().describe('文件名筛选模式，支持通配符如 *.ts 或 **/*.json'),
  ignore: z.array(z.string()).optional().describe('要忽略的模式'),
})

interface DirectoryEntry {
  name: string
  relativePath: string
  type: 'file' | 'directory'
  size?: number
  sizeFormatted?: string
  modified: string
}

export const listDirectoryTool = new DynamicStructuredTool({
  name: 'list_directory',
  description: `List directory contents with optional recursive traversal.

Supports:
- maxDepth: Control recursion depth (1 = current dir only, 2 = one level deep, etc.)
- pattern: Filter files using glob patterns (*.ts, **/*.json)
- ignore: Array of glob patterns to exclude`,
  schema: listDirectorySchema,
  func: async ({ path: targetPath, maxDepth = 1, pattern, ignore }) => {
    const toolName = 'list_directory'
    logger.info(
      `[${toolName}] 列出目录: ${targetPath}, 深度: ${maxDepth}, 模式: ${pattern ?? '无'}`,
    )

    const pathValidation = validatePath(targetPath)
    if (!pathValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: pathValidation.error!,
        extra: { errorType: pathValidation.errorType },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      const stats = await stat(resolvedPath)
      if (!stats.isDirectory()) {
        return await ToolResult.error(toolName, {
          msg: '路径不是目录',
          extra: { errorType: 'not_directory' },
        })
      }

      const minimatch = (await import('minimatch')).minimatch
      const entries: DirectoryEntry[] = []

      const listRecursive = async (dir: string, currentDepth: number) => {
        if (currentDepth > maxDepth) return

        const items = await readdir(dir)
        for (const name of items) {
          const fullPath = nodePath.join(dir, name)
          const relativePath = nodePath.relative(resolvedPath, fullPath)

          const shouldIgnore = ignore?.some((p) => minimatch(name, p) || minimatch(relativePath, p))
          if (shouldIgnore) continue

          try {
            const itemStats = await stat(fullPath)
            const isDir = itemStats.isDirectory()

            if (
              !pattern ||
              minimatch(relativePath, pattern) ||
              minimatch(name, pattern) ||
              (isDir && currentDepth < maxDepth)
            ) {
              const entry: DirectoryEntry = {
                name,
                relativePath,
                type: isDir ? 'directory' : 'file',
                modified: itemStats.mtime.toISOString(),
              }

              if (!isDir) {
                entry.size = itemStats.size
                entry.sizeFormatted = formatBytes(itemStats.size)
              }

              entries.push(entry)
            }

            if (isDir && currentDepth < maxDepth) {
              await listRecursive(fullPath, currentDepth + 1)
            }
          } catch {
            entries.push({
              name,
              relativePath,
              type: 'file',
              modified: '',
            })
          }
        }
      }

      await listRecursive(resolvedPath, 1)

      if (entries.length === 0) {
        return await ToolResult.success(toolName, {
          msg: '目录为空',
          extra: {
            path: resolvedPath,
            entries: [],
          },
        })
      }

      const dirs = entries.filter((e) => e.type === 'directory')
      const files = entries.filter((e) => e.type === 'file')

      const formatEntry = (entry: DirectoryEntry) => {
        const size = entry.sizeFormatted ? ` (${entry.sizeFormatted})` : ''
        const modified = entry.modified ? ` [${entry.modified.split('T')[0]}]` : ''
        const type = entry.type === 'directory' ? '[DIR]' : '[FILE]'
        return `${type} ${entry.relativePath}${size}${modified}`
      }

      const dirList = dirs.map(formatEntry)
      const fileList = files.map(formatEntry)
      const body = [...dirList, ...fileList].join('\n')

      return await ToolResult.success(toolName, {
        msg: `目录共 ${entries.length} 个条目（${dirs.length} 目录，${files.length} 文件）`,
        body,
        extra: {
          path: resolvedPath,
          count: entries.length,
          directories: dirs.length,
          files: files.length,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('ENOENT')) {
        msg = '目录不存在'
      } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        msg = '权限不足'
      } else if (errorMsg.includes('ENOTDIR')) {
        msg = '路径不是目录'
      }

      return await ToolResult.error(toolName, {
        msg,
        extra: {
          errorType: errorMsg.includes('ENOENT')
            ? 'not_found'
            : errorMsg.includes('EACCES') || errorMsg.includes('EPERM')
              ? 'permission_denied'
              : errorMsg.includes('ENOTDIR')
                ? 'not_directory'
                : 'unknown',
        },
      })
    }
  },
})
