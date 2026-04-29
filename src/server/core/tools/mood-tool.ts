import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../utils'
import { ToolResult } from '../../utils/tool-response'
import { STATE_CONTEXT } from '../state/context/impl/character-state'

export const updateMoodValuesTool = new DynamicStructuredTool({
  name: 'update_mood_values',
  description: '更新情绪和人格状态值',
  schema: z.object({
    pad: z.object({
      pleasure: z.number().min(-1).max(1),
      arousal: z.number().min(0).max(1),
      dominance: z.number().min(0).max(1),
    }),
    big_five: z.object({
      extraversion: z.number().min(0).max(10),
      agreeableness: z.number().min(0).max(10),
      openness: z.number().min(0).max(10),
      conscientiousness: z.number().min(0).max(10),
      neuroticism: z.number().min(0).max(10),
    }),
  }),
  func: async (input) => {
    const toolName = 'update_mood_values'
    await STATE_CONTEXT.updatePAD(input.pad)
    await STATE_CONTEXT.updateBigFive(input.big_five)

    logger.info({ pad: input.pad, bigFive: input.big_five }, '[情绪工具] 状态已更新')

    return await ToolResult.success(toolName, {
      msg: '情绪状态已更新',
      extra: {
        pad: input.pad,
        big_five: input.big_five,
      },
    })
  },
})
