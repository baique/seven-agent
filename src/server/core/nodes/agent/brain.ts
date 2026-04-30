import { logger } from '../../../utils'
import { StreamPrimaryPersonModel } from '../../model'
import { AIMessage, BaseMessage } from '@langchain/core/messages'
import { coreTools } from '../../tools/tools-collection'
import { getModelConfigManager } from '../../../config/model-config'

/**
 * LLM 调用结果
 */
export interface BrainSpeakResult {
  /** AI 消息 */
  message: AIMessage
  /** Token 使用统计（原始 usage_metadata + 耗时 + 模型名称） */
  usage?: Record<string, unknown> & { elapsedMs: number; modelName: string }
}

logger.info(`[Brain] 绑定 ${coreTools.length} 个核心工具`)
const withTools = StreamPrimaryPersonModel.bindTools(coreTools)

/**
 * 与完整人格对话
 * @param messages  对话内容
 * @param signal    AbortSignal 用于取消请求
 * @returns  对话结果（包含消息和统计）
 */
export const BrainSpeak = async (
  context: BaseMessage[],
  signal?: AbortSignal,
): Promise<BrainSpeakResult> => {
  const startTime = Date.now()
  try {
    const result = await withTools.invoke(context, { signal })

    const elapsed = Date.now() - startTime

    // DEBUG: 打印完整的 LLM 返回结果
    logger.debug(
      {
        content: result.content,
        tool_calls: result.tool_calls,
        additional_kwargs: result.additional_kwargs,
        usage_metadata: result.usage_metadata,
      },
      '[LLM] 完整返回结果',
    )

    const usage = result?.usage_metadata
    let usageData: BrainSpeakResult['usage'] | undefined

    // 从 LLM 响应中获取实际使用的模型名称，如果没有则使用配置的主模型名称
    const responseMetadata = (result as any)?.response_metadata
    const modelManager = getModelConfigManager()
    const modelName =
      responseMetadata?.model ||
      responseMetadata?.model_name ||
      modelManager?.getPrimaryName() ||
      'unknown'

    if (usage) {
      usageData = {
        ...usage,
        elapsedMs: elapsed,
        modelName,
      }
    }

    return { message: result, usage: usageData }
  } catch (err) {
    // 检查是否是取消错误
    if (err instanceof Error && err.name === 'AbortError') {
      logger.info('[LLMNode] 请求被取消')
      throw err
    }
    logger.error(err, '[LLMNode] 思考出错')
  }
  return { message: new AIMessage('出错啦') }
}
