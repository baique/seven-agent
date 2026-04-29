/**
 * Agent管理模块
 * 负责创建和管理LangGraph Agent实例，以及从消息文件加载今天的对话历史
 */

import { BasicAgentWrapper } from './basic'
import { GLOBAL_MEMORY, type MemoryMessage } from '../../memory'
import { logger } from '../../utils'

/**
 * 从今天的内存文件读取对话历史
 * 转换为前端可用的格式
 * @returns 今天的历史消息列表
 */
export const getChatHistory = async (): Promise<MemoryMessage[]> => {
  try {
    logger.info('Reading today messages from memory')
    const todayMessages = await GLOBAL_MEMORY.queryRecentMessagesByLimit(50)
    logger.info(`Read ${todayMessages.length} messages from today`)

    return todayMessages
  } catch (error) {
    logger.error(error, 'Failed to read today messages:')
    return []
  }
}

/**
 * 创建Agent实例
 * 初始化checkpointer并创建带有持久化能力的Agent
 * @returns Agent实例
 */
export const createAgent = async () => {
  return new BasicAgentWrapper().createAgent({
    // checkpointer: new MemorySaver(),
  })
}

export { BasicAgentWrapper } from './basic'
export { AbstractAgentWrapper } from './base-wrapper'
export { MessageProcessor, messageProcessor } from './message-processor'
