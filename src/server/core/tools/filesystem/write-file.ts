import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const writeFileSchema = z.object({
  file_path: z.string().describe('要写入的文件绝对路径'),
  content: z.string().describe('要写入的文件内容'),
  createDirs: z.boolean().optional().default(true).describe('是否自动创建父目录，默认true'),
})

export const writeFileTool = new DynamicStructuredTool({
  name: 'write_file',
  description: `向指定路径写入文件内容。会自动创建不存在的目录。
用于创建新文件或覆盖现有文件。`,
  schema: writeFileSchema,
  func: async ({ file_path, content, createDirs }) => {
    const toolName = 'write_file'
    logger.info(`[${toolName}] 写入文件: ${file_path}, 内容长度: ${content.length}`)

    const pathValidation = validatePath(file_path)
    if (!pathValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: pathValidation.error!,
        extra: { errorType: pathValidation.errorType },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      if (createDirs) {
        const dir = path.dirname(resolvedPath)
        await mkdir(dir, { recursive: true })
      }

      await writeFile(resolvedPath, content, 'utf-8')
      const stats = await stat(resolvedPath)

      return await ToolResult.success(toolName, {
        msg: `文件写入成功 (${stats.size} 字节)`,
        extra: {
          file_path: resolvedPath,
          bytesWritten: stats.size,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('ENOENT')) {
        msg = '文件或目录不存在'
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
