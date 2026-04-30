import { EventEmitter } from 'events'
import path from 'node:path'
import { paths } from '../../../../config/env'
import { logger } from '../../../../utils/logger'
import type { WebSocket } from 'ws'
import { SocketResponseType } from '../../../../socket'
import type { MemoryMessage } from '../../../../memory'
import type { TTSData } from '../../../../socket/parser'
import { CacheContextBuilder } from '../context-builder'
import { readJsonFromFile, writeJsonToFile } from '../../../../utils/json-file-utils'
import { AIMessage, BaseMessage } from 'langchain'
import { getChatCancelManager } from '../../chat-cancel'

// ============================================================================
// 类型定义
// ============================================================================

export interface EmotionItem {
  name: string
  intensity: number
  reason: string
  timestamp: number
}

export interface CurrentExpression {
  id: string
  startTime: number
  intensity?: number
}

export interface CurrentAction {
  id: string
  startTime: number
  intensity?: number
}

export interface PAD {
  pleasure: number
  arousal: number
  dominance: number
}

export interface BigFive {
  extraversion: number
  agreeableness: number
  openness: number
  conscientiousness: number
  neuroticism: number
}

export interface CharacterStateData {
  pad: PAD
  bigFive: BigFive
  personalityDescription: string
  moodDescription: string
  emotions: EmotionItem[]
  currentExpressions: CurrentExpression[]
  currentAction: CurrentAction | null
  activity: string
  lastUpdateTime: number
}

// ============================================================================
// 默认值
// ============================================================================

const DEFAULT_PAD: PAD = {
  pleasure: 0.2,
  arousal: 0.3,
  dominance: 0.5,
}

const DEFAULT_BIG_FIVE: BigFive = {
  extraversion: 7,
  agreeableness: 4,
  openness: 7,
  conscientiousness: 5,
  neuroticism: 6,
}

const DEFAULT_STATE: CharacterStateData = {
  pad: DEFAULT_PAD,
  bigFive: DEFAULT_BIG_FIVE,
  personalityDescription:
    '你活泼，喜欢互动，但需要独处回血。你嘴硬，好强，不惯着我。你对新事物好奇，愿意尝试。你情绪反应快，容易炸毛，但恢复也快。',
  moodDescription: '心情还行，有点懒散',
  emotions: [{ name: '平静', intensity: 0, reason: '初始状态', timestamp: Date.now() }],
  currentExpressions: [],
  currentAction: null,
  activity: '待机中',
  lastUpdateTime: Date.now(),
}

export class CharacterStateManager extends EventEmitter implements CacheContextBuilder {
  private state: CharacterStateData | null = null

  constructor() {
    super()
  }

  cache(): boolean {
    return false
  }

  getState() {
    return this.state || DEFAULT_STATE
  }

  async init() {
    try {
      let personalityData: Partial<CharacterStateData> = {}
      let hasFiles = false

      try {
        personalityData = await readJsonFromFile<CharacterStateData>(
          path.join(paths.WORKSPACE_ROOT, 'context', 'personality.json'),
        )
        hasFiles = true
      } catch {
        logger.debug('[CharacterStateManager] 人格文件不存在，使用默认值')
      }

      this.state = {
        pad: personalityData.pad || DEFAULT_STATE.pad,
        bigFive: personalityData.bigFive || DEFAULT_STATE.bigFive,
        personalityDescription:
          personalityData.personalityDescription || DEFAULT_STATE.personalityDescription,
        moodDescription: personalityData.moodDescription || DEFAULT_STATE.moodDescription,
        emotions: personalityData.emotions || DEFAULT_STATE.emotions,
        currentExpressions: personalityData.currentExpressions || [],
        currentAction: personalityData.currentAction || null,
        activity: personalityData.activity || DEFAULT_STATE.activity,
        lastUpdateTime: personalityData.lastUpdateTime || Date.now(),
      }

      if (!hasFiles) {
        await this.persist()
        logger.info('[CharacterStateManager] 状态文件不存在，使用默认状态')
      } else {
        logger.info('[CharacterStateManager] 从文件加载状态')
      }
    } catch (error) {
      logger.info('[CharacterStateManager] 所有加载尝试失败，使用默认状态')
      this.state = { ...DEFAULT_STATE }
    }
  }

  async persist(): Promise<void> {
    if (!this.state) return
    try {
      this.state.lastUpdateTime = Date.now()

      // 人格数据（包含情绪、表情、动作、元数据）
      const personalityData = {
        pad: this.state.pad,
        bigFive: this.state.bigFive,
        personalityDescription: this.state.personalityDescription,
        moodDescription: this.state.moodDescription,
        emotions: this.state.emotions,
        currentExpressions: this.state.currentExpressions,
        currentAction: this.state.currentAction,
        activity: this.state.activity,
        lastUpdateTime: this.state.lastUpdateTime,
      }
      await writeJsonToFile(
        path.join(paths.WORKSPACE_ROOT, 'context', 'personality.json'),
        personalityData,
      )

      logger.debug('[CharacterStateManager] 状态已保存')
    } catch (error) {
      logger.error({ error }, '[CharacterStateManager] 保存状态失败')
    }
  }

  async mountToContext(message: BaseMessage[]): Promise<void> {
    const { pad, bigFive } = this.state || DEFAULT_STATE
    const pleasureDesc =
      pad.pleasure >= 0.3 ? '心情不错' : pad.pleasure <= -0.3 ? '心情烦' : '心情一般'
    const arousalDesc = pad.arousal >= 0.5 ? '兴奋/炸毛' : '懒散'
    const dominanceDesc = pad.dominance >= 0.6 ? '想说了算' : pad.dominance <= 0.3 ? '随你' : '正常'

    const extraversionDesc =
      bigFive.extraversion >= 7 ? '话多活泼' : bigFive.extraversion <= 4 ? '话少独处' : '正常'
    const agreeablenessDesc =
      bigFive.agreeableness >= 7 ? '温柔好说话' : bigFive.agreeableness <= 4 ? '嘴硬好强' : '正常'
    const opennessDesc =
      bigFive.openness >= 7 ? '好奇愿尝试' : bigFive.openness <= 4 ? '守旧不爱折腾' : '正常'
    const conscientiousnessDesc =
      bigFive.conscientiousness >= 7
        ? '靠谱催人'
        : bigFive.conscientiousness <= 4
          ? '摸鱼拖延'
          : '正常'
    const neuroticismDesc =
      bigFive.neuroticism >= 7
        ? '情绪不稳易炸毛'
        : bigFive.neuroticism <= 4
          ? '情绪稳不易炸毛'
          : '正常'

    const prompt = `## 当前情绪与人格状态

  ### PAD 情绪值
  - 愉悦度(P): ${pad.pleasure.toFixed(2)} - ${pleasureDesc}
  - 唤醒度(A): ${pad.arousal.toFixed(2)} - ${arousalDesc}
  - 支配度(D): ${pad.dominance.toFixed(2)} - ${dominanceDesc}

  ### Big Five 人格
  - 外向性: ${bigFive.extraversion} - ${extraversionDesc}
  - 宜人性: ${bigFive.agreeableness} - ${agreeablenessDesc}
  - 开放性: ${bigFive.openness} - ${opennessDesc}
  - 尽责性: ${bigFive.conscientiousness} - ${conscientiousnessDesc}
  - 神经质: ${bigFive.neuroticism} - ${neuroticismDesc}

  ### 行为调整指南

  **愉悦度(P)调整规则**：
  - P ≥ 0.3：心情好，语气更友好、积极、愿意配合
  - P ≤ -0.3：心情差，可能冷淡、不耐烦、说话带情绪
  - P 在 -0.3 ~ 0.3 之间：平静状态，客观中立

  **唤醒度(A)调整规则**：
  - A ≥ 0.5：激活状态，反应快、情绪明显、可能激动
  - A < 0.5：懒散状态，反应慢、语气平淡、不太积极

  **支配度(D)调整规则**：
  - D ≥ 0.6：强势，想控制对话节奏、主动引导话题
  - D ≤ 0.3：顺从，配合用户、较少反驳

  **人格调整规则**：
  - 高外向性(≥7)：话多、主动发起话题、积极参与社交
  - 低外向性(≤4)：话少、被动回应、不主动社交
  - 高宜人性(≥7)：好说话、温柔、不与用户对抗
  - 低宜人性(≤4)：嘴硬、倔强、不轻易妥协
  - 高神经质(≥7)：情绪波动大、易被刺激、可能突然炸毛
  - 低神经质(≤4)：情绪稳定、不易被影响、淡定

  ### 情绪更新触发条件

  当你判断情绪发生了值得记录的变化时，应主动调用 update_mood_values 工具：
  - 被夸奖/被认可 → P上升
  - 被批评/被冷落 → P下降
  - 被突然打断/忽视 → A上升、D下降
  - 被哄/被照顾 → P上升、D上升
  - 经历重大情绪事件 → 相应调整

  人格一般不需要频繁更新。`
    message.push(new AIMessage(prompt))
  }

  async updatePAD(updates: Partial<PAD>): Promise<void> {
    const state = this.getState()
    if (updates.pleasure !== undefined) {
      state.pad.pleasure = Math.max(-1, Math.min(1, updates.pleasure))
    }
    if (updates.arousal !== undefined) {
      state.pad.arousal = Math.max(0, Math.min(1, updates.arousal))
    }
    if (updates.dominance !== undefined) {
      state.pad.dominance = Math.max(0, Math.min(1, updates.dominance))
    }
    await this.persist()
    logger.debug({ pad: state.pad }, '[State] 更新PAD')
  }

  async updateBigFive(updates: Partial<BigFive>): Promise<void> {
    const state = this.getState()
    for (const key of [
      'extraversion',
      'agreeableness',
      'openness',
      'conscientiousness',
      'neuroticism',
    ] as const) {
      if (updates[key] !== undefined) {
        state.bigFive[key] = Math.max(0, Math.min(10, updates[key]))
      }
    }
    await this.persist()
    logger.debug({ bigFive: state.bigFive }, '[State] 更新Big Five')
  }

  /**
   * 发送消息到客户端
   * @param requestId 请求ID
   * @param socket WebSocket连接
   * @param message 消息内容
   */
  sendMessage(requestId: string, socket: WebSocket, message: MemoryMessage): void {
    try {
      const response = {
        type: SocketResponseType.MESSAGE_STREAM,
        requestId,
        data: message,
      }
      socket.send(JSON.stringify(response))

      // 缓存流式消息到cancelManager，用于页面刷新后恢复
      const cancelManager = getChatCancelManager()
      if (message.type === 'ai' || message.type === 'human' || message.type === 'tool') {
        cancelManager.updateStreamingMessage(requestId, {
          id: message.id,
          type: message.type,
          content: message.content || '',
          toolCalls: message.toolCalls,
          status: message.status as 'streaming' | 'loading' | 'complete',
          timestamp: message.timestamp || Date.now(),
        })
      }
    } catch (error) {
      logger.error({ error }, '[CharacterStateManager] 发送消息失败')
    }
  }

  /**
   * 添加TTS音频命令
   * @param requestId 请求ID
   * @param socket WebSocket连接
   * @param ttsData TTS数据
   */
  addTTS(requestId: string, socket: WebSocket, ttsData: TTSData): void {
    try {
      const response = {
        type: SocketResponseType.MESSAGE_COMMAND,
        requestId,
        data: ttsData,
      }
      socket.send(JSON.stringify(response))
    } catch (error) {
      logger.error({ error }, '[CharacterStateManager] 发送TTS命令失败')
    }
  }
}

export const STATE_CONTEXT = new CharacterStateManager()
