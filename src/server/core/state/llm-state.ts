import type { BaseMessage } from '@langchain/core/messages'
import { ReducedValue, StateSchema, MessagesValue } from '@langchain/langgraph'
import z from 'zod'

export const MessagesState = new StateSchema({
  messages: MessagesValue,
  bufferMessages: z.array(z.custom<BaseMessage>()).default([]),
  llmCalls: new ReducedValue(z.number().default(0), { reducer: (x, y) => x + y }),
  /** 当前请求ID，用于取消对话功能 */
  requestId: z.string().optional(),
  /** 工具调用后是否需要回到LLM */
  hasToolCalls: z.boolean().default(false),
  /** 是否已取消 */
  cancelled: z.boolean().default(false),
})
