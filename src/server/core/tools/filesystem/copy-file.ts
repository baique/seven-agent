import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat, access, mkdir, copyFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../../utils/logger'
import { validatePath, formatBytes } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const copyFileSchema = z.object({
  source: z.string().describe('源文件或目录绝对路径'),
  destination: z.string().describe('目标文件或目录绝对路径'),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否覆盖已存在的目标文件/目录，默认false'),
})

async function copyDirectoryRecursive(
  src: string,
  dest: string,
): Promise<{ filesCopied: number; bytesCopied: number }> {
  let filesCopied = 0
  let bytesCopied = 0

  await mkdir(dest, { recursive: true })
  const entries = await readdir(src)

  for (const entry of entries) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    const stats = await stat(srcPath)

    if (stats.isDirectory()) {
      const subResult = await copyDirectoryRecursive(srcPath, destPath)
      filesCopied += subResult.filesCopied
      bytesCopied += subResult.bytesCopied
    } else {
      await copyFile(srcPath, destPath)
      filesCopied++
      bytesCopied += stats.size
    }
  }

  return { filesCopied, bytesCopied }
}

export const copyFileTool = new DynamicStructuredTool({
  name: 'copy_file',
  description: `Copy a file or directory to a destination path.

Supports both files and directories.
- For files: copies the file to the destination
- For directories: recursively copies all contents (like cp -r)
Automatically creates parent directories if they don't exist.`,
  schema: copyFileSchema,
  func: async ({ source, destination, overwrite }) => {
    const toolName = 'copy_file'
    logger.info(`[${toolName}] 复制: ${source} -> ${destination}`)

    const srcValidation = validatePath(source)
    if (!srcValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: `源路径无效: ${srcValidation.error}`,
        extra: { errorType: srcValidation.errorType },
      })
    }

    const destValidation = validatePath(destination)
    if (!destValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: `目标路径无效: ${destValidation.error}`,
        extra: { errorType: destValidation.errorType },
      })
    }

    const resolvedSrc = srcValidation.resolvedPath
    const resolvedDest = destValidation.resolvedPath

    try {
      const srcStats = await stat(resolvedSrc)
      const isDirectory = srcStats.isDirectory()

      if (!overwrite) {
        try {
          await access(resolvedDest)
          return await ToolResult.error(toolName, {
            msg: '目标已存在，请使用 overwrite=true 覆盖',
            extra: { errorType: 'file_exists' },
          })
        } catch {
          // 目标不存在，可以继续
        }
      }

      const destDir = path.dirname(resolvedDest)
      await mkdir(destDir, { recursive: true })

      if (isDirectory) {
        const result = await copyDirectoryRecursive(resolvedSrc, resolvedDest)
        return await ToolResult.success(toolName, {
          msg: `目录复制成功，共复制 ${result.filesCopied} 个文件`,
          extra: {
            source: resolvedSrc,
            destination: resolvedDest,
            type: 'directory',
            filesCopied: result.filesCopied,
            bytesCopied: result.bytesCopied,
            bytesFormatted: formatBytes(result.bytesCopied),
          },
        })
      } else {
        await copyFile(resolvedSrc, resolvedDest)
        return await ToolResult.success(toolName, {
          msg: '文件复制成功',
          extra: {
            source: resolvedSrc,
            destination: resolvedDest,
            type: 'file',
            bytesCopied: srcStats.size,
            bytesFormatted: formatBytes(srcStats.size),
          },
        })
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('ENOENT')) {
        msg = '源文件或目录不存在'
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
