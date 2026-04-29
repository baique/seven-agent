import { z } from 'zod'

export const TTSSpeedSchema = z.enum(['slow', 'stand', 'fast']).describe('语速')

const StateInTTSSchema = z.object({
  id: z.string().describe('表情或动作名称'),
  type: z.literal('state').describe('状态命令'),
  intensity: z.number().min(0).max(100).describe('强度，0-100之间'),
  stateType: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .describe('状态类型: 1=表情, 2=动作, 3=情绪'),
})

export type StateInTTS = z.infer<typeof StateInTTSSchema>

export const TTSCommandSchema = z.object({
  type: z.literal('tts').describe('语音命令'),
  text: z.string().describe('要说内容'),
  speed: TTSSpeedSchema.optional().describe('语速，slow慢/stand默认/fast快，可选'),
  state: z.array(StateInTTSSchema).optional().describe('做出表情/动作/情绪'),
  pauseAfter: z
    .number()
    .optional()
    .describe('说完后的停顿秒数，0-5秒之间，可选，用于多句话时控制节奏'),
})

export const OutputCommandSchema = z.discriminatedUnion('type', [TTSCommandSchema])

export const PersonOutputSchema = z.object({
  output: z.array(OutputCommandSchema).describe('说话/做表情/做动作/情绪变化'),
  timestamp: z.number().optional().describe('时间戳，由系统自动填充'),
})

export type TTSCommand = z.infer<typeof TTSCommandSchema>
export type OutputCommand = z.infer<typeof OutputCommandSchema>
export type PersonOutput = z.infer<typeof PersonOutputSchema>
