import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const fileExistsSchema = z.object({
  file_path: z.string().describe('要检查的文件或目录绝对路径'),
})

export const fileExistsTool = new DynamicStructuredTool({
  name: 'file_exists',
  description: `Check if a file or directory exists at the specified path.

Returns:
- exists: true/false
- type: 'file' or 'directory' (only if exists)
- If path validation fails, returns exists: false with reason`,
  schema: fileExistsSchema,
  func: async ({ file_path }) => {
    const toolName = 'file_exists'
    logger.info(`[${toolName}] 检查文件存在: ${file_path}`)

    const pathValidation = validatePath(file_path)
    if (!pathValidation.valid) {
      return await ToolResult.success(toolName, {
        msg: '文件不存在',
        extra: {
          file_path,
          exists: false,
          reason: pathValidation.error,
        },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      const stats = await stat(resolvedPath)
      return await ToolResult.success(toolName, {
        msg: '文件存在',
        extra: {
          file_path: resolvedPath,
          exists: true,
          type: stats.isDirectory() ? 'directory' : 'file',
        },
      })
    } catch {
      return await ToolResult.success(toolName, {
        msg: '文件不存在',
        extra: {
          file_path: resolvedPath,
          exists: false,
        },
      })
    }
  },
})
