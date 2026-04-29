import { AIMessage, BaseMessage, SystemMessage } from 'langchain'
import { ContextBuilder } from '../context-builder'
import { buildPersonPrompt } from '../../../../prompt/primary'
import { convertToMessages } from '../../../../utils'
import { GLOBAL_MEMORY } from '../../../../memory'
import { buildCoreMemoryPrompt } from '../../../../memory/memory-injector'

/**
 * 系统提示词
 */
export class SystemContextBuilder implements ContextBuilder {
  init(): Promise<void> {
    return Promise.resolve()
  }
  async mountToContext(message: BaseMessage[]): Promise<void> {
    message.push(new SystemMessage(await buildPersonPrompt()))
  }
  persist(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * 日总结
 */
export class DaySummaryContextBuilder implements ContextBuilder {
  init(): Promise<void> {
    return Promise.resolve()
  }
  async mountToContext(message: BaseMessage[]): Promise<void> {
    const summaries = await GLOBAL_MEMORY.queryDaySummaries(3)
    message.push(...convertToMessages(summaries))
  }
  persist(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * 长期记忆
 */
export class LongTermMemoryContextBuilder implements ContextBuilder {
  init(): Promise<void> {
    return Promise.resolve()
  }
  async mountToContext(message: BaseMessage[]): Promise<void> {
    const prompt = await buildCoreMemoryPrompt()
    message.push(new AIMessage(`[长期记忆区-START]\n${prompt}\n[长期记忆区-END]`))
  }
  persist(): Promise<void> {
    return Promise.resolve()
  }
}

export const SYSTEM = {
  SYSTEM_CONTEXT: new SystemContextBuilder(),
  DAY_SUMMARY_CONTEXT: new DaySummaryContextBuilder(),
  LONG_MEMORY_CONTEXT: new LongTermMemoryContextBuilder(),
}
