import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat, access, mkdir, rename, readdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const moveFileSchema = z.object({
  source: z.string().describe('源文件或目录绝对路径'),
  destination: z.string().describe('目标文件或目录绝对路径'),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否覆盖已存在的目标文件/目录，默认false'),
})

async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src)
  for (const entry of entries) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    const stats = await stat(srcPath)
    if (stats.isDirectory()) {
      await copyDirectory(srcPath, destPath)
    } else {
      await copyFile(srcPath, destPath)
    }
  }
}

async function moveDirectory(src: string, dest: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    await copyDirectory(src, dest)
    const entries = await readdir(src)
    for (const entry of entries) {
      const srcPath = path.join(src, entry)
      const stats = await stat(srcPath)
      if (stats.isDirectory()) {
        await rmRecursive(srcPath)
      } else {
        await unlinkRecursive(srcPath)
      }
    }
    await rmRecursive(src)
  } else {
    await copyDirectory(src, dest)
  }
}

async function unlinkRecursive(filePath: string): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  await unlink(filePath)
}

async function rmRecursive(dirPath: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(dirPath, { recursive: true })
}

export const moveFileTool = new DynamicStructuredTool({
  name: 'move_file',
  description: `Move or rename a file or directory to a destination path.

Supports both files and directories.
If destination is an existing directory, source will be moved into it.
If overwrite=true and destination exists, it will be replaced.`,
  schema: moveFileSchema,
  func: async ({ source, destination, overwrite }) => {
    const toolName = 'move_file'
    logger.info(`[${toolName}] 移动: ${source} -> ${destination}`)

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
            msg: '目标文件已存在，请使用 overwrite=true 覆盖',
            extra: { errorType: 'file_exists' },
          })
        } catch {
          // 目标不存在，可以继续
        }
      }

      const destDir = path.dirname(resolvedDest)
      await mkdir(destDir, { recursive: true })

      if (isDirectory) {
        await moveDirectory(resolvedSrc, resolvedDest, overwrite)
      } else {
        await rename(resolvedSrc, resolvedDest)
      }

      return await ToolResult.success(toolName, {
        msg: isDirectory ? '目录移动成功' : '文件移动成功',
        extra: {
          source: resolvedSrc,
          destination: resolvedDest,
          type: isDirectory ? 'directory' : 'file',
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('ENOENT')) {
        msg = '源文件或目录不存在'
      } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        msg = '权限不足'
      } else if (errorMsg.includes('EXDEV')) {
        msg = '源和目标不在同一文件系统，无法移动'
      }

      return await ToolResult.error(toolName, {
        msg,
        extra: {
          errorType: errorMsg.includes('ENOENT')
            ? 'not_found'
            : errorMsg.includes('EACCES') || errorMsg.includes('EPERM')
              ? 'permission_denied'
              : errorMsg.includes('EXDEV')
                ? 'cross_device'
                : 'unknown',
        },
      })
    }
  },
})
