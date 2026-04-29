import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { logger } from '../../../utils/logger'
import { validatePath } from '../../../utils/path-policy'
import { ToolResult } from '../../../utils/tool-response'

const editFileSchema = z.object({
  file_path: z.string().describe('要编辑的文件绝对路径'),
  old_string: z.string().describe('要查找并替换的原文（必须精确匹配，包括所有缩进和空白字符）'),
  new_string: z.string().optional().default('').describe('替换后的内容，为空表示删除匹配内容'),
  replace_all: z.boolean().optional().default(false).describe('是否替换所有匹配项，默认false'),
})

function calculateSimilarity(s1: string, s2: string): number {
  const len1 = s1.length
  const len2 = s2.length
  const matrix: number[][] = []

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      )
    }
  }

  const distance = matrix[len1][len2]
  const maxLen = Math.max(len1, len2)
  return maxLen === 0 ? 1 : 1 - distance / maxLen
}

function findMostSimilarBlock(
  content: string,
  target: string,
  windowSize: number,
): { block: string; similarity: number } | null {
  const normalizedTarget = target.replace(/\r\n/g, '\n').trim()
  const normalizedContent = content.replace(/\r\n/g, '\n')

  if (normalizedTarget.length === 0 || normalizedContent.length === 0) {
    return null
  }

  let mostSimilar: { block: string; similarity: number } | null = null

  for (let i = 0; i <= normalizedContent.length - windowSize; i++) {
    const window = normalizedContent.slice(i, i + windowSize)
    const similarity = calculateSimilarity(window, normalizedTarget)

    if (!mostSimilar || similarity > mostSimilar.similarity) {
      mostSimilar = { block: window, similarity }
    }
  }

  return mostSimilar
}

export const editFileTool = new DynamicStructuredTool({
  name: 'edit_file',
  description: `编辑文件内容。通过搜索并替换指定内容来修改文件。

使用说明：
1. old_string 必须精确匹配（包括缩进和空白字符）
2. new_string 为空表示删除匹配内容
3. 如果 replace_all=false 但匹配到多处，会返回错误
4. 工具会自动处理换行符差异（Windows的\\r\\n和Linux的\\n）

示例：
- 正确：提供包含完整上下文的几行代码块
- 错误：只提供常见的一行代码如 "return true"`,
  schema: editFileSchema,
  func: async ({ file_path, old_string, new_string, replace_all }) => {
    const toolName = 'edit_file'
    logger.info(`[${toolName}] 编辑文件: ${file_path}, replace_all: ${replace_all}`)

    const pathValidation = validatePath(file_path)
    if (!pathValidation.valid) {
      return await ToolResult.error(toolName, {
        msg: pathValidation.error!,
        extra: { errorType: pathValidation.errorType },
      })
    }

    const resolvedPath = pathValidation.resolvedPath

    try {
      const content = await readFile(resolvedPath, 'utf-8')

      const normalizedContent = content.replace(/\r\n/g, '\n')
      const normalizedOld = old_string.replace(/\r\n/g, '\n')

      const matchCount = normalizedContent.split(normalizedOld).length - 1

      if (matchCount === 0) {
        const similarBlock = findMostSimilarBlock(content, old_string, normalizedOld.length)

        let suggestion = ''
        if (similarBlock && similarBlock.similarity > 0.5) {
          suggestion = `\n\n最相似的内容（相似度 ${(similarBlock.similarity * 100).toFixed(1)}%）：\n\`\`\`\n${similarBlock.block}\n\`\`\``
        }

        return await ToolResult.error(toolName, {
          msg: `未找到要替换的内容。${suggestion}`,
          extra: { errorType: 'content_not_found' },
        })
      }

      if (matchCount > 1 && !replace_all) {
        const hint = `文件内容如下，请提供更具体的 old_string 进行精确替换：`
        return await ToolResult.error(toolName, {
          msg: `找到 ${matchCount} 处匹配，请使用 replace_all=true 替换全部，或提供更具体的 old_string`,
          body: hint + '\n' + content,
          extra: { errorType: 'multiple_matches', matchCount },
        })
      }

      let finalOld = old_string
      let finalNew = new_string
      let index = content.indexOf(old_string)

      if (index === -1) {
        const fileUsesCRLF = content.includes('\r\n')
        if (fileUsesCRLF) {
          finalOld = old_string.replace(/\n/g, '\r\n')
          finalNew = new_string.replace(/\n/g, '\r\n')
        } else {
          finalOld = old_string.replace(/\r\n/g, '\n')
          finalNew = new_string.replace(/\r\n/g, '\n')
        }
        index = content.indexOf(finalOld)
      }

      if (index === -1) {
        return await ToolResult.error(toolName, {
          msg: '未找到要替换的内容',
          extra: { errorType: 'content_not_found' },
        })
      }

      let newContent: string
      let actualReplaceCount: number

      if (replace_all) {
        actualReplaceCount = matchCount
        newContent = content.split(finalOld).join(finalNew)
      } else {
        actualReplaceCount = 1
        newContent = content.slice(0, index) + finalNew + content.slice(index + finalOld.length)
      }

      await writeFile(resolvedPath, newContent, 'utf-8')

      const actionDesc = finalNew === '' ? '删除' : '替换'
      return await ToolResult.success(toolName, {
        msg: `成功${actionDesc} ${actualReplaceCount} 处`,
        extra: {
          file_path: resolvedPath,
          replaceCount: actualReplaceCount,
          action: finalNew === '' ? 'delete' : 'replace',
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
