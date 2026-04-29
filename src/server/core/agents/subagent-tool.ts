import { DynamicStructuredTool } from '@langchain/core/tools'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { logger } from '../../utils/logger'
import { ToolResult } from '../../utils/tool-response'
import { baseToolsByName } from '../tools/tools-collection'
import { requiresReview, REVIEW_MESSAGES } from '../review'
import { mcpToolManager } from '../tools/mcp'
import { CreateModel } from '../model'
import { getAgents, getAgentByName, parseToolReference } from './agents-loader'
import { getReviewManager } from '../review'
import type { Agent, ToolReference } from './agents-loader'

/**
 * 工具查找缓存，支持内置工具和 MCP 工具
 */
class ToolResolver {
  private mcpToolsCache: Map<string, DynamicStructuredTool> = new Map()

  /**
   * 根据工具引用解析工具实例
   * @param ref 工具引用
   * @returns 工具实例，不存在返回 undefined
   */
  async resolve(ref: ToolReference): Promise<DynamicStructuredTool | undefined> {
    switch (ref.type) {
      case 'builtin':
        return baseToolsByName[ref.toolName!]

      case 'mcp_tool': {
        const cacheKey = `${ref.serverName}/${ref.mcpToolName}`
        if (this.mcpToolsCache.has(cacheKey)) {
          return this.mcpToolsCache.get(cacheKey)
        }
        const tool = await mcpToolManager.getToolByName(ref.serverName!, ref.mcpToolName!)
        if (tool) {
          this.mcpToolsCache.set(cacheKey, tool)
        }
        return tool
      }

      default:
        return undefined
    }
  }

  /**
   * 解析服务器所有工具
   * @param serverName MCP 服务器名称
   * @returns 工具列表
   */
  async resolveServerTools(serverName: string): Promise<DynamicStructuredTool[]> {
    return mcpToolManager.getToolsByServer(serverName)
  }

  /**
   * 根据完整名称查找工具（支持内置工具和 MCP 工具）
   * @param fullName 完整工具名称
   * @returns 工具实例，不存在返回 undefined
   */
  async findByFullName(fullName: string): Promise<DynamicStructuredTool | undefined> {
    const builtinTool = baseToolsByName[fullName]
    if (builtinTool) {
      return builtinTool
    }

    if (this.mcpToolsCache.has(fullName)) {
      return this.mcpToolsCache.get(fullName)
    }

    const allMCPTools = await mcpToolManager.getTools()
    const mcpTool = allMCPTools.find((t) => t.name === fullName)
    if (mcpTool) {
      this.mcpToolsCache.set(fullName, mcpTool)
    }
    return mcpTool
  }
}

const toolResolver = new ToolResolver()

/**
 * 构建子 Agent 可用的工具列表
 * @param toolRefs 工具引用列表
 * @returns 工具实例列表
 */
async function buildAvailableTools(toolRefs?: string[]): Promise<DynamicStructuredTool[]> {
  if (!toolRefs || toolRefs.length === 0) {
    return []
  }

  const tools: DynamicStructuredTool[] = []

  for (const ref of toolRefs) {
    const parsed = parseToolReference(ref)

    if (parsed.type === 'mcp_server') {
      const serverTools = await toolResolver.resolveServerTools(parsed.serverName!)
      tools.push(...serverTools)
      logger.info(`[SubAgent] 加载 MCP 服务器 ${parsed.serverName} 的 ${serverTools.length} 个工具`)
    } else {
      const tool = await toolResolver.resolve(parsed)
      if (tool) {
        tools.push(tool)
      } else {
        logger.warn(`[SubAgent] 工具 ${ref} 不存在，已跳过`)
      }
    }
  }

  return tools
}

/**
 * SubAgent执行结果
 */
interface SubAgentResult {
  success: boolean
  content: string
  toolCalls?: Array<{
    tool: string
    input: unknown
    output: unknown
  }>
  duration: number
}

/**
 * 执行SubAgent任务
 * 采用全新隔离模式：独立的LLM调用链，不共享主Agent上下文
 */
async function executeSubAgent(
  agent: Agent,
  task: string,
  parentContext?: string,
): Promise<SubAgentResult> {
  const startTime = Date.now()

  try {
    // 构建可用工具列表（支持内置工具和 MCP 工具）
    const availableTools = await buildAvailableTools(agent.tools)

    // 创建带自定义参数的模型
    const modelArgs: Partial<ConstructorParameters<typeof ChatOpenAI>[0]> = {}
    if (agent.modelParams?.temperature !== undefined) {
      // 确保 temperature 是数字类型（YAML 解析可能返回字符串）
      modelArgs.temperature = Number(agent.modelParams.temperature)
    }
    if (agent.modelParams?.maxTokens !== undefined) {
      // 确保 maxTokens 是数字类型（YAML 解析可能返回字符串）
      modelArgs.maxTokens = Number(agent.modelParams.maxTokens)
    }

    const model = CreateModel(modelArgs)

    // 绑定工具
    const modelWithTools = availableTools.length > 0 ? model.bindTools(availableTools) : model

    // 构建消息 - 全新会话，不携带主Agent历史
    // 使用 LangChain 消息类型确保格式正确
    const messages: Array<
      | { role: 'system'; content: string }
      | { role: 'user'; content: string }
      | { role: 'assistant'; content: string; tool_calls?: any[] }
      | { role: 'tool'; content: string; tool_call_id: string }
    > = [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: buildTaskPrompt(task, parentContext) },
    ]

    // 执行迭代
    const maxIterations = agent.maxIterations ?? 15
    const toolCalls: SubAgentResult['toolCalls'] = []
    let currentContent = ''
    let iterations = 0

    while (iterations < maxIterations) {
      iterations++

      const response = await modelWithTools.invoke(messages)
      currentContent = response.content as string

      // 检查是否有工具调用
      const toolCallsInResponse = (response as any).tool_calls
      if (!toolCallsInResponse || toolCallsInResponse.length === 0) {
        break
      }

      // 执行工具调用（带审查机制）
      const toolResults: string[] = []
      const reviewManager = getReviewManager()

      for (const call of toolCallsInResponse) {
        const tool = await toolResolver.findByFullName(call.name)
        if (!tool) {
          toolResults.push(`工具 "${call.name}" 不存在`)
          toolCalls.push({
            tool: call.name,
            input: call.args,
            output: `错误: 工具 "${call.name}" 不存在`,
          })
          continue
        }

        // 检查是否需要审查
        const mode = reviewManager.getMode()
        let result: string

        if (mode === 'manual' && requiresReview(call.name)) {
          logger.debug({ toolName: call.name, agent: agent.name }, '[SubAgent] 工具需要审查')

          const reviewResult = await reviewManager.createReview({
            id: `subagent-${Date.now()}-${call.name}`,
            name: call.name,
            args: call.args as Record<string, unknown>,
          })

          if (!reviewResult.approved) {
            logger.info({ toolName: call.name, agent: agent.name }, '[SubAgent] 工具执行被拒绝')
            result = reviewResult.reason || REVIEW_MESSAGES.REJECTED
            toolCalls.push({
              tool: call.name,
              input: call.args,
              output: result,
            })
            toolResults.push(`${call.name}: ${result}`)
            continue
          }

          if (reviewResult.simulated) {
            logger.info({ toolName: call.name, agent: agent.name }, '[SubAgent] 工具执行模拟成功')
            result = reviewResult.reason || REVIEW_MESSAGES.SIMULATED
            toolCalls.push({
              tool: call.name,
              input: call.args,
              output: result,
            })
            toolResults.push(`${call.name}: ${result}`)
            continue
          }
        }

        // 执行工具
        result = await tool.invoke(call.args)
        toolCalls.push({
          tool: call.name,
          input: call.args,
          output: result,
        })
        toolResults.push(`${call.name}: ${result}`)
      }

      // 某些 API（如 MiniMax）不支持多轮工具调用
      // 将工具结果附加到内容中，不再进行第二轮模型调用
      currentContent += '\n\n[工具执行结果]\n' + toolResults.join('\n')
      break
    }

    return {
      success: true,
      content: currentContent,
      toolCalls,
      duration: Date.now() - startTime,
    }
  } catch (error) {
    logger.error({ error }, `[SubAgent] 执行失败: ${agent.name}`)
    return {
      success: false,
      content: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
      duration: Date.now() - startTime,
    }
  }
}

/**
 * 构建任务提示词
 */
function buildTaskPrompt(task: string, parentContext?: string): string {
  const lines: string[] = []

  if (parentContext) {
    lines.push('## 父任务上下文')
    lines.push(parentContext)
    lines.push('')
  }

  lines.push('## 当前任务')
  lines.push(task)
  lines.push('')
  lines.push('## 执行要求')
  lines.push('1. 仔细分析任务需求')
  lines.push('2. 必要时使用可用工具收集信息')
  lines.push('3. 给出完整、准确的执行结果')
  lines.push('4. 如果无法完成，说明原因')

  return lines.join('\n')
}

// ============================================
// 工具定义
// ============================================

/**
 * SubAgent调用工具
 */
export const subagentTool = new DynamicStructuredTool({
  name: 'subagent',
  description: `启动专门的子代理(SubAgent)执行特定领域的复杂任务。

**适用场景：**
- 需要多步骤搜索和整合信息的调研任务
- 代码审查、架构评审等技术评估任务
- 需要专项分析的复杂问题

**使用步骤：**
1. 先调用 list_subagents 查看可用代理列表
2. 选择合适的type，清晰描述task
3. 接收结果后继续主流程

**注意：**
- 简单任务（1-2个工具调用）直接处理，不要滥用SubAgent
- 子代理在独立上下文中执行，不继承主代理的历史消息
- 子代理可能调用多个工具，耗时可能较长`,
  schema: z.object({
    type: z.string().describe('SubAgent类型名称（如: search, code-review）'),
    task: z.string().describe('要执行的具体任务描述'),
    context: z.string().optional().describe('父任务上下文信息（可选）'),
  }),
  func: async (input) => {
    const toolName = 'subagent'
    const agent = await getAgentByName(input.type)

    if (!agent) {
      const availableAgents = await getAgents()
      const availableNames = availableAgents.map((a) => a.name).join(', ')
      return await ToolResult.error(toolName, {
        msg: `未找到类型为 "${input.type}" 的SubAgent`,
        body: `可用类型: ${availableNames || '无'}`,
        extra: { requestedType: input.type },
      })
    }

    const result = await executeSubAgent(agent, input.task, input.context)

    if (result.success) {
      const lines: string[] = []
      lines.push(`## SubAgent(${agent.name})执行结果`)
      lines.push('')
      lines.push(result.content)

      if (result.toolCalls && result.toolCalls.length > 0) {
        lines.push('')
        lines.push(
          `*执行了 ${result.toolCalls.length} 次工具调用，耗时 ${(result.duration / 1000).toFixed(1)}秒*`,
        )
      }

      return await ToolResult.success(toolName, {
        msg: `SubAgent(${agent.name})执行完成`,
        body: lines.join('\n'),
        extra: {
          type: agent.name,
          duration: result.duration,
          toolCallCount: result.toolCalls?.length ?? 0,
        },
      })
    } else {
      return await ToolResult.error(toolName, {
        msg: `SubAgent(${agent.name})执行失败`,
        body: result.content,
        extra: {
          type: agent.name,
          duration: result.duration,
        },
      })
    }
  },
})

/**
 * 查询可用SubAgent工具
 */
export const listSubAgentsTool = new DynamicStructuredTool({
  name: 'list_subagents',
  description: '列出所有可用的SubAgent类型及其功能说明',
  schema: z.object({}),
  func: async () => {
    const toolName = 'list_subagents'
    const agents = await getAgents()

    const lines: string[] = ['## 可用SubAgent列表', '']

    for (const agent of agents) {
      lines.push(`### ${agent.name}`)
      lines.push(agent.description)
      if (agent.tools && agent.tools.length > 0) {
        lines.push(`\n可用工具: ${agent.tools.join(', ')}`)
      }
      lines.push('')
    }

    if (agents.length === 0) {
      lines.push('（暂无可用子代理）')
      lines.push('')
      lines.push('提示：可以在 workspace/agents/ 目录下创建子代理配置')
    }

    return await ToolResult.success(toolName, {
      msg: `找到 ${agents.length} 个SubAgent`,
      body: lines.join('\n'),
      extra: {
        count: agents.length,
        agents: agents.map((a) => ({ name: a.name, description: a.description })),
      },
    })
  },
})

/**
 * SubAgent工具集合
 */
export const subAgentTools = [subagentTool, listSubAgentsTool]
