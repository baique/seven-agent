import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { mkdir } from 'node:fs/promises'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const createDirectorySchema = z.object({
  path: z.string().describe('要创建的目录绝对路径'),
})

export const createDirectoryTool = new DynamicStructuredTool({
  name: 'create_directory',
  description: `Create a directory at the specified path.

Automatically creates all parent directories if they don't exist (like mkdir -p).
If the directory already exists, this operation succeeds without error (idempotent).`,
  schema: createDirectorySchema,
  func: async ({ path }) => {
    const toolName = 'create_directory'
    logger.info(`[${toolName}] 创建目录: ${path}`)

    const pathValidation = validatePath(path)
    if (!pathValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: pathValidation.error!,
        extra: { errorType: pathValidation.errorType },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      await mkdir(resolvedPath, { recursive: true })
      return await ToolResult.success(toolName, {
        msg: '目录创建成功',
        extra: {
          path: resolvedPath,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[${toolName}] 执行失败: ${errorMsg}`)

      let msg = errorMsg
      if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        msg = '权限不足，无法创建目录'
      } else if (errorMsg.includes('ENOTDIR')) {
        msg = '父路径不是目录'
      }

      return await ToolResult.error(toolName, {
        msg,
        extra: {
          errorType:
            errorMsg.includes('EACCES') || errorMsg.includes('EPERM')
              ? 'permission_denied'
              : errorMsg.includes('ENOTDIR')
                ? 'not_directory'
                : 'unknown',
        },
      })
    }
  },
})
