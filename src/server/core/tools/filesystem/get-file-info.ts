import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../../utils/logger'
import { validatePath, getFileType } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const getFileInfoSchema = z.object({
  file_path: z.string().describe('要获取信息的文件或目录绝对路径'),
})

export const getFileInfoTool = new DynamicStructuredTool({
  name: 'get_file_info',
  description: `Get detailed information about a file or directory.

Returns:
- Type (file/directory)
- Size and formatted size
- File type category (text, binary, archive, etc.)
- Extension
- Timestamps (created, modified, accessed)
- Permissions (octal)`,
  schema: getFileInfoSchema,
  func: async ({ file_path }) => {
    const toolName = 'get_file_info'
    logger.info(`[${toolName}] 获取文件信息: ${file_path}`)

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
      const fileType = getFileType(resolvedPath)
      const ext = path.extname(resolvedPath).toLowerCase()

      return await ToolResult.success(toolName, {
        msg: '获取文件信息成功',
        extra: {
          file_path: resolvedPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          fileType,
          extension: ext || null,
          size: stats.size,
          sizeFormatted: formatBytes(stats.size),
          created: stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString(),
          accessed: stats.atime.toISOString(),
          permissions: stats.mode.toString(8).slice(-3),
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
