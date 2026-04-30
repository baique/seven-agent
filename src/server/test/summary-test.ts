import { HumanMessage, BaseMessage } from '@langchain/core/messages'
import { messageProcessor } from '../core/graph'
import { BrainSpeak } from '../core/nodes/agent/brain'
import { CTX } from '../core/state/context'
import { generateSessionNotes, getLongMemoryPrompt, getTaskPrompt } from '../core/summary'
import { GLOBAL_MEMORY } from '../memory'
import { convertToMessages, logger } from '../utils'
import { convertMemoryMessageToBaseMessages } from '../utils/message-utils'

const test = async () => {
  // 首次摘要

  const messages = await GLOBAL_MEMORY.getMessagesByIdRange(
    'fdbe7eb5-0e3e-44ed-a4bc-aad276f4297e',
    '063e0c477eed60ef2070f67784d438d0',
  )

  logger.info(`[Summary] 读取 ${messages.length} 条消息`)
  if (messages.length === 0) {
    return
  }
  // 下一次摘要
  const messagesNext = await GLOBAL_MEMORY.getMessagesByIdRange(
    '1223d032-1222-4d94-98ff-007a223567bb',
    '063fb4ad4fa790215efbaf712012ec88',
  )

  logger.info(`[Summary] 二轮读取 ${messagesNext.length} 条消息`)
  if (messagesNext.length === 0) {
    return
  }

  await CTX.init()
  const messageArray: BaseMessage[] = convertMemoryMessageToBaseMessages(messages)
  const messageContext = await CTX.createMessageContext(
    [
      new HumanMessage(
        '[system]\n上下文即将压缩，现在请立即记录所有关键信息;当没有更多需要记录的信息后输出:[no_more_information]\n[system]',
      ),
    ],
    messageArray,
  )
  const response = await BrainSpeak(messageContext)
  logger.info(response, `[Summary] 原生FORK摘要`)

  const result = await generateSessionNotes(
    convertMemoryMessageToBaseMessages(messages),
    await getTaskPrompt(),
    await getLongMemoryPrompt(),
  )
  logger.info(`二轮摘要读取 ${messagesNext.length} 条消息`)
  const resultNext = await generateSessionNotes(
    convertMemoryMessageToBaseMessages(messagesNext),
    await getTaskPrompt(),
    await getLongMemoryPrompt(),
    result?.notes || '',
  )
}

test()
