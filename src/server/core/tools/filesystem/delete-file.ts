import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat, readdir, unlink, rm } from 'node:fs/promises'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const deleteFileSchema = z.object({
  file_path: z.string().describe('要删除的文件或目录绝对路径'),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe('递归删除目录及其内容，默认false。危险操作，请谨慎使用'),
})

export const deleteFileTool = new DynamicStructuredTool({
  name: 'delete_file',
  description: `Delete a file or directory.

WARNING: This operation is irreversible. Deleted files cannot be recovered.

For directories:
- recursive=false (default): Only deletes empty directories
- recursive=true: Deletes directory and all contents (dangerous)`,
  schema: deleteFileSchema,
  func: async ({ file_path, recursive }) => {
    const toolName = 'delete_file'
    logger.info(`[${toolName}] 删除: ${file_path}, 递归: ${recursive}`)

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

      if (stats.isDirectory()) {
        if (!recursive) {
          const items = await readdir(resolvedPath)
          if (items.length > 0) {
            return await ToolResult.error(toolName, {
              msg: '目录不为空，请使用 recursive=true 递归删除',
              extra: { errorType: 'directory_not_empty' },
            })
          }
        }
        await rm(resolvedPath, { recursive })
        return await ToolResult.success(toolName, {
          msg: '目录删除成功',
          extra: {
            file_path: resolvedPath,
            type: 'directory',
          },
        })
      } else {
        await unlink(resolvedPath)
        return await ToolResult.success(toolName, {
          msg: '文件删除成功',
          extra: {
            file_path: resolvedPath,
            type: 'file',
          },
        })
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('ENOENT')) {
        msg = '文件或目录不存在'
      } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        msg = '权限不足'
      } else if (errorMsg.includes('EBUSY')) {
        msg = '文件正在被使用，无法删除'
      }

      return await ToolResult.error(toolName, {
        msg,
        extra: {
          errorType: errorMsg.includes('ENOENT')
            ? 'not_found'
            : errorMsg.includes('EACCES') || errorMsg.includes('EPERM')
              ? 'permission_denied'
              : errorMsg.includes('EBUSY')
                ? 'in_use'
                : 'unknown',
        },
      })
    }
  },
})
