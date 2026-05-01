/**
 * 扩展工具管理工具
 *
 * 统一接口管理 MCP 等外部扩展工具
 * 提供发现、加载、执行的完整流程
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../utils/logger'
import { ToolResult } from '../../utils/tool-response'
import { mcpToolManager, parseMCPToolName, mcpToolCacheManager } from './mcp'
import { getMCPServers } from './mcp/config'
import { callMCPTool } from './mcp/client'
import { requiresReview, REVIEW_MESSAGES, getReviewManager } from '../review'
import { getToolTrimStrategy, trimRawBody } from '../../utils/tool-response-parser'
import { baseToolsByName } from './core-tools'

/**
 * 搜索扩展工具
 */
export const extSearchTool = new DynamicStructuredTool({
  name: 'ext_search',
  description: `搜索可用的扩展工具（GitHub、Slack等外部服务）。

**使用场景：**
- 需要某个功能时，搜索是否有对应的扩展工具
- 查找特定服务的工具（如搜索"github"找GitHub相关工具）

**搜索语法：**
- 支持空格分隔的多个关键词
- 使用 OR 逻辑：匹配任一关键词即返回
- 同时搜索工具名称和描述

**示例：**
- ext_search({"query": "github"}) → 返回GitHub相关工具
- ext_search({"query": "github webhook"}) → 返回包含"github"或"webhook"的工具
- ext_search({"query": ""}) → 返回所有可用工具（同ext_list）`,
  schema: z.object({
    query: z
      .string()
      .describe('搜索关键词，支持空格分隔多个关键词（OR逻辑），为空则返回所有扩展工具'),
  }),
  func: async (input) => {
    const toolName = 'ext_search'
    const query = input.query || ''

    try {
      const tools = await mcpToolManager.getToolsMetadata()

      // 解析空格分隔的关键词，支持 OR 逻辑
      const keywords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((k) => k.length > 0)

      const filtered =
        keywords.length > 0
          ? tools.filter((t) => {
              const nameLower = t.name.toLowerCase()
              const descLower = (t.description || '').toLowerCase()
              return keywords.some(
                (keyword) => nameLower.includes(keyword) || descLower.includes(keyword),
              )
            })
          : tools

      if (filtered.length === 0) {
        return await ToolResult.success(toolName, {
          msg: '未找到匹配的扩展工具',
          body: '未找到匹配的扩展工具。使用ext_list()查看全部可用工具。',
          extra: { query, count: 0 },
        })
      }

      const lines = ['## 扩展工具搜索结果', '']
      if (query) {
        lines.push(`搜索关键词: "${query}"`)
        lines.push('')
      }
      lines.push(`找到 ${filtered.length} 个工具：\n`)

      for (const tool of filtered) {
        const fullName = `mcp__${tool.serverName}__${tool.name}`
        lines.push(`- **${fullName}**`)
        lines.push(`  描述: ${tool.description || '无描述'}`)
        lines.push('')
      }

      return await ToolResult.success(toolName, {
        msg: `找到 ${filtered.length} 个扩展工具`,
        body: lines.join('\n'),
        extra: {
          query,
          count: filtered.length,
          tools: filtered.map((t) => ({
            name: `mcp__${t.serverName}__${t.name}`,
            description: t.description,
            serverName: t.serverName,
            toolName: t.name,
          })),
        },
      })
    } catch (error) {
      logger.error({ error }, '[ExtSearch] 搜索失败')
      return await ToolResult.error(toolName, {
        msg: '搜索扩展工具失败',
        body: error instanceof Error ? error.message : String(error),
        extra: { query },
      })
    }
  },
})

/**
 * 列出所有扩展工具
 */
export const extListTool = new DynamicStructuredTool({
  name: 'ext_list',
  description: `列出所有可用的扩展工具。

**使用场景：**
- 查看系统中有哪些扩展能力可用
- 浏览所有外部服务工具

**示例：**
- ext_list()`,
  schema: z.object({}),
  func: async () => {
    const toolName = 'ext_list'
    try {
      const tools = await mcpToolManager.getToolsMetadata()
      const servers = getMCPServers()

      if (tools.length === 0) {
        return await ToolResult.success(toolName, {
          msg: '暂无扩展工具',
          body: '当前未配置任何扩展工具。可在 workspace/mcp.json 中配置MCP服务器。',
          extra: { count: 0 },
        })
      }

      const lines = ['## 扩展工具列表', '']
      lines.push(`已配置 ${servers.length} 个服务器，共 ${tools.length} 个工具：\n`)

      // 按服务器分组
      const toolsByServer = new Map<string, typeof tools>()
      for (const tool of tools) {
        if (!toolsByServer.has(tool.serverName)) {
          toolsByServer.set(tool.serverName, [])
        }
        toolsByServer.get(tool.serverName)!.push(tool)
      }

      for (const [serverName, serverTools] of toolsByServer) {
        lines.push(`### ${serverName}`)
        for (const tool of serverTools) {
          lines.push(`- **${tool.name}**`)
          lines.push(`  ${tool.description || '无描述'}`)
        }
        lines.push('')
      }

      lines.push('---')
      lines.push('使用 ext_invoke 直接执行工具')

      return await ToolResult.success(toolName, {
        msg: `共 ${tools.length} 个扩展工具`,
        body: lines.join('\n'),
        extra: {
          count: tools.length,
          serverCount: servers.length,
        },
      })
    } catch (error) {
      logger.error({ error }, '[ExtList] 列出失败')
      return await ToolResult.error(toolName, {
        msg: '列出扩展工具失败',
        body: error instanceof Error ? error.message : String(error),
      })
    }
  },
})

/**
 * 执行扩展工具
 */
export const extInvokeTool = new DynamicStructuredTool({
  name: 'ext_invoke',
  description: `执行扩展工具。

**使用场景：**
- 已知道工具名称，需要执行工具
- 通过ext_search找到工具后直接调用

**示例：**
- ext_invoke({
    "tool_name": "mcp__github__search_repositories",
    "arguments": {"query": "machine learning", "language": "python"}
  })`,
  schema: z.object({
    tool_name: z.string().describe('完整工具名称，格式：mcp__服务器名__工具名'),
    arguments: z.record(z.string(), z.any()).describe('工具参数，根据工具描述构造'),
  }),
  func: async (input) => {
    const toolName = 'ext_invoke'
    try {
      const fullName = input.tool_name
      const parsed = parseMCPToolName(fullName)

      if (!parsed) {
        return await ToolResult.error(toolName, {
          msg: '无效的工具名称',
          body: '格式应为：mcp__服务器名__工具名',
          extra: { toolName: fullName },
        })
      }

      const { serverName, toolName: mcpToolName } = parsed

      // 检查是否需要审查
      const reviewManager = getReviewManager()
      const mode = reviewManager.getMode()
      if (mode === 'manual' && requiresReview(fullName)) {
        logger.debug({ toolName: fullName }, '[ExtInvoke] 工具需要审查')

        const result = await reviewManager.createReview({
          id: `ext_invoke_${Date.now()}`,
          name: fullName,
          args: input.arguments,
        })

        if (!result.approved) {
          logger.info({ toolName: fullName }, '[ExtInvoke] 工具执行被拒绝')
          const rejectMessage = result.reason || REVIEW_MESSAGES.REJECTED
          return await ToolResult.error(toolName, {
            msg: '工具执行被拒绝',
            body: rejectMessage,
            extra: { toolName: fullName },
          })
        }
      }

      // 执行工具
      logger.info(`[ExtInvoke] 执行工具: ${fullName}`)
      const result = await callMCPTool(serverName, mcpToolName, input.arguments)

      let textContent = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')

      // 应用截断策略
      const strategy = getToolTrimStrategy(fullName)
      const trimmedContent = await trimRawBody(textContent, {
        maxChars: strategy.maxSourceChars,
        maxLines: undefined,
        mode: strategy.trimMode,
      })
      if (trimmedContent !== textContent) {
        logger.info(
          `[ExtInvoke] 工具 ${fullName} 响应已截断: ${textContent.length} -> ${trimmedContent.length}`,
        )
        textContent = trimmedContent
      }

      return await ToolResult.success(toolName, {
        msg: '工具执行成功',
        body: textContent || '(无输出)',
        extra: {
          toolName: fullName,
          isError: result.isError,
        },
      })
    } catch (error) {
      logger.error({ error }, '[ExtInvoke] 执行失败')

      // 获取工具帮助信息
      let helpInfo = ''
      try {
        const helpResult = (await extHelpTool.func({ tool_name: input.tool_name })) as string
        // 解析帮助结果，提取raw_body部分
        const separatorIndex = helpResult.indexOf('\n\n[RAW_BODY]\n')
        if (separatorIndex > 0) {
          helpInfo = helpResult.substring(separatorIndex + '\n\n[RAW_BODY]\n'.length)
        } else {
          helpInfo = helpResult
        }
      } catch (helpError) {
        logger.warn({ helpError }, '[ExtInvoke] 获取工具帮助信息失败')
        helpInfo = '无法获取工具帮助信息'
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      const rawBody = `## 执行失败信息\n${errorMessage}\n\n## 工具帮助信息\n${helpInfo}`

      return await ToolResult.error(toolName, {
        msg: '执行扩展工具失败',
        body: rawBody,
        extra: { toolName: input.tool_name, arguments: input.arguments },
      })
    }
  },
})

/**
 * 获取工具详细schema信息
 */
export const extHelpTool = new DynamicStructuredTool({
  name: 'ext_help',
  description: `获取工具的使用帮助

**使用场景：**
- 了解某个工具如何调用
- 查看工具的完整描述和使用说明
- 确认参数类型和必填项

**示例：**
- ext_help({"tool_name": "mcp__github__search_repositories"}) → 返回GitHub搜索工具的详细schema
- ext_help({"tool_name": "read_file"}) → 返回核心工具read_file的schema`,
  schema: z.object({
    tool_name: z
      .string()
      .describe('工具名称，可以是MCP工具（格式：mcp__服务器名__工具名）或核心工具名称'),
  }),
  func: async (input) => {
    const toolName = 'ext_help'
    const targetToolName = input.tool_name

    try {
      // 1. 先检查是否是MCP工具
      const parsed = parseMCPToolName(targetToolName)
      if (parsed) {
        const { serverName, toolName: mcpToolName } = parsed
        const cache = mcpToolCacheManager.readCache(serverName)

        if (!cache) {
          return await ToolResult.error(toolName, {
            msg: '未找到工具',
            body: `服务器 ${serverName} 的缓存不存在，请确保MCP服务器已配置`,
            extra: { toolName: targetToolName },
          })
        }

        const toolInfo = cache.tools.find((t) => t.name === mcpToolName)
        if (!toolInfo) {
          return await ToolResult.error(toolName, {
            msg: '未找到工具',
            body: `在服务器 ${serverName} 中未找到工具 ${mcpToolName}`,
            extra: { toolName: targetToolName },
          })
        }

        const lines = [`## ${targetToolName} 工具详情`, '']
        lines.push(`**服务器**: ${serverName}`)
        lines.push(`**工具名**: ${mcpToolName}`)
        lines.push(`**描述**: ${toolInfo.description || '无描述'}`)
        lines.push('')
        lines.push('### 参数Schema')
        lines.push('```json')
        lines.push(JSON.stringify(toolInfo.inputSchema, null, 2))
        lines.push('```')

        return await ToolResult.success(toolName, {
          msg: `获取 ${targetToolName} 的schema信息成功`,
          body: lines.join('\n'),
          extra: {
            toolName: targetToolName,
            serverName,
            mcpToolName,
            description: toolInfo.description,
            inputSchema: toolInfo.inputSchema,
          },
        })
      }

      // 2. 检查是否是核心工具
      const coreTool = baseToolsByName[targetToolName]
      if (coreTool) {
        const lines = [`## ${targetToolName} 工具详情`, '']
        lines.push(`**类型**: 核心工具`)
        lines.push(`**描述**: ${coreTool.description || '无描述'}`)
        lines.push('')
        lines.push('### 参数Schema')
        lines.push('```json')
        // 从schema中提取结构信息
        const schemaShape = (coreTool.schema as z.ZodObject<z.ZodRawShape>).shape
        if (schemaShape) {
          const schemaObj: Record<string, { type: string; description?: string }> = {}
          for (const [key, value] of Object.entries(schemaShape)) {
            const zodType = value as z.ZodType & { description?: string }
            schemaObj[key] = {
              type: zodType.constructor.name.replace('Zod', '').toLowerCase(),
              description: zodType.description,
            }
          }
          lines.push(JSON.stringify({ type: 'object', properties: schemaObj }, null, 2))
        } else {
          lines.push('{}')
        }
        lines.push('```')

        return await ToolResult.success(toolName, {
          msg: `获取 ${targetToolName} 的schema信息成功`,
          body: lines.join('\n'),
          extra: {
            toolName: targetToolName,
            type: 'core',
            description: coreTool.description,
          },
        })
      }

      // 3. 未找到工具
      return await ToolResult.error(toolName, {
        msg: '未找到工具',
        body: `未找到名为 ${targetToolName} 的工具。请使用 ext_list 查看可用工具。`,
        extra: { toolName: targetToolName },
      })
    } catch (error) {
      logger.error({ error }, '[ExtHelp] 获取工具信息失败')
      return await ToolResult.error(toolName, {
        msg: '获取工具信息失败',
        body: error instanceof Error ? error.message : String(error),
        extra: { toolName: targetToolName },
      })
    }
  },
})

/**
 * 扩展工具管理工具集合
 */
export const extManagementTools = [extSearchTool, extListTool, extInvokeTool, extHelpTool]
