/** 会话笔记模块 - V3版本 */

import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { SummarizationModel } from '../model'
import { BUFFER_WINDOW_CONTEXT } from '../state/context/impl/buffer-window'
import { logger } from '../../utils/logger'
import { configManager, paths } from '../../config/env'
import { taskManager } from '../tools/task/task-manager'
import { parseSessionNotes } from './parser'
import { SESSION_NOTES_PROMPT } from './prompt'
import type { SessionNotes, TaskSkillBinding, RememberOperation, SceneBoundary } from './types'
import { MessageTokenCounter } from '../../utils/message-token-counter'
import { SESSION_NODE_CONTEXT } from '../state/context/impl/session-node'
import { getHybridServer } from '../../socket'
import { SocketResponseType } from '../../socket/types'
import { applyRetentionPolicy } from '../../utils/tool-response-parser'
import { retryWithExponentialBackoff } from '../../utils/retry-utils'
import { buildCoreMemoryPrompt } from '../../memory/memory-injector'
import { REMEMBER_PROMPT } from '../../prompt/template'
import { formatDate } from '../../utils'
import { jsonMemoryManager } from '../../memory/json-memory-manager'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { hookManager } from '../hook'

/** 情感关键词列表，用于检测情感密度 */
const EMOTIONAL_KEYWORDS = new Set([
  '开心',
  '难过',
  '生气',
  '焦虑',
  '担心',
  '害怕',
  '喜欢',
  '讨厌',
  '谢谢',
  '抱歉',
  '对不起',
  '辛苦',
  '累',
  '烦',
  '高兴',
  '幸福',
  '孤独',
  '寂寞',
  '感动',
  '温暖',
  '想念',
  '思念',
  '爱',
  '恨',
  '愤怒',
  '失望',
  '希望',
  '期待',
  '紧张',
  '放松',
  '安心',
])

/**
 * 检查是否应该触发会话笔记生成
 */
const shouldTriggerNotes = (): boolean => {
  const counter = BUFFER_WINDOW_CONTEXT.getCounter()
  const { totalTokens, roundCount } = counter.getCount()
  const notesTriggerRounds = configManager.get('NOTES_TRIGGER_ROUNDS')
  const notesTriggerToken = configManager.get('NOTES_TRIGGER_TOKEN')
  const toolDensityTrigger = configManager.get('TOOL_DENSITY_TRIGGER')
  const emotionalDensityTrigger = configManager.get('EMOTIONAL_DENSITY_TRIGGER')
  const densityMinRounds = configManager.get('DENSITY_TRIGGER_MIN_ROUNDS')

  const roundsTrigger = roundCount >= notesTriggerRounds
  const tokenTrigger = totalTokens >= notesTriggerToken

  // 工具密度检测
  const messages = BUFFER_WINDOW_CONTEXT.getMessages()
  const toolMsgCount = messages.filter((m) => ToolMessage.isInstance(m)).length
  const toolDensity = messages.length > 0 ? toolMsgCount / messages.length : 0
  const isToolDensityTriggered = toolDensity >= toolDensityTrigger && roundCount >= densityMinRounds

  // 情感密度检测
  const userMsgs = messages.filter((m) => HumanMessage.isInstance(m))
  const emotionalUserMsgs = userMsgs.filter((m) => {
    const content = typeof m.content === 'string' ? m.content : ''
    return Array.from(EMOTIONAL_KEYWORDS).some((kw) => content.includes(kw))
  })
  const emotionalDensity = userMsgs.length > 0 ? emotionalUserMsgs.length / userMsgs.length : 0
  const isEmotionalDensityTriggered =
    emotionalDensity >= emotionalDensityTrigger && roundCount >= densityMinRounds

  const triggered =
    roundsTrigger || tokenTrigger || isToolDensityTriggered || isEmotionalDensityTriggered

  if (triggered) {
    const reason = roundsTrigger
      ? '轮数触发'
      : tokenTrigger
        ? 'token触发'
        : isToolDensityTriggered
          ? `工具密度触发(${(toolDensity * 100).toFixed(0)}%)`
          : `情感密度触发(${(emotionalDensity * 100).toFixed(0)}%)`
    logger.info(
      `[会话笔记] 触发 - ${reason} | tokens: ${totalTokens}/${notesTriggerToken} rounds: ${roundCount}/${notesTriggerRounds}`,
    )
  }

  return triggered
}

/**
 * 构建提示词模板
 * 替换模板中的变量
 */
const buildPrompt = async (messages: BaseMessage[], existingSummary?: string): Promise<string> => {
  const allTasksResult = await taskManager.queryTasks(true)
  const allTasks = allTasksResult.tasks || []

  let taskInfo: string
  if (allTasks.length === 0) {
    taskInfo = '暂无任务'
  } else {
    const taskLines = allTasks.map((task) => {
      return JSON.stringify({ id: task.id, description: task.description })
    })
    taskInfo = `所有任务(${allTasks.length}个):\n${taskLines.join('\n')}`
  }

  const notesDesc = existingSummary ? existingSummary : '（无）'

  const coreMemory = (await buildCoreMemoryPrompt(true)) || '无'
  const currentTime = formatDate(new Date())
  const messagesStr = MessageTokenCounter.formatForLLM(messages)

  return SESSION_NOTES_PROMPT.replace('{{coreMemory}}', coreMemory)
    .replace('{{rememberPrompt}}', REMEMBER_PROMPT)
    .replace('{{currentTime}}', currentTime)
    .replace('{{taskInfo}}', taskInfo)
    .replace('{{existingNotes}}', notesDesc)
    .replace('{{messages}}', messagesStr)
}

/**
 * 生成会话笔记（仅生成，不保存）
 */
export const generateSessionNotes = async (
  messages: BaseMessage[],
): Promise<SessionNotes | null> => {
  const maxRetryCount = configManager.get('SESSION_NOTES_RETRY_COUNT')
  const existingSummary = SESSION_NODE_CONTEXT.summary
  const prompt = await buildPrompt(messages, existingSummary)

  try {
    logger.info(`开始摘要……`)

    return await retryWithExponentialBackoff(
      async () => {
        const response = await SummarizationModel.invoke([
          new SystemMessage(prompt),
          new HumanMessage({ content: '请按照提示词要求完成任务，只输出JSON格式结果。' }),
        ])
        const content = response.content as string

        logger.info(`摘要原文: \n${content}`)

        // 解析结果
        const result = parseSessionNotes(content)

        // 检查解析是否成功（notes字段有值且不是原文）
        if (result.notes && result.notes !== content) {
          return result
        }
        // 解析失败，抛出错误触发重试
        throw new Error('JSON 解析失败，回退到文本模式')
      },
      {
        maxRetries: maxRetryCount,
        delayMs: 5000,
        onRetry: (attempt, error) => {
          const delay = Math.min(5000 * Math.pow(2, attempt), 30000)
          logger.warn(`[会话笔记] 第 ${attempt} 次尝试失败: ${error.message}, ${delay}ms 后重试`)
        },
      },
    )
  } catch (error) {
    logger.error(`[会话笔记] 重试 ${maxRetryCount} 次后仍然失败: ${(error as Error).message}`)
    return null
  }
}

/**
 * 执行记忆操作（remember）
 * 调用update_memory工具的实现
 * @param operations 记忆操作列表
 */
const executeRememberOperations = async (operations: RememberOperation[]): Promise<void> => {
  if (operations.length === 0) return

  for (const op of operations) {
    try {
      switch (op.action) {
        case 'add': {
          if (!op.content) {
            logger.warn(`[Remember] add操作缺少content`)
            continue
          }
          // 默认过期时间3个月
          const expireAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          const memory = await jsonMemoryManager.addFragmentMemory(
            op.content,
            op.importance ?? 0.5,
            expireAt.toISOString(),
          )
          logger.info(`[Remember] 添加记忆: ${memory.id}`)
          break
        }
        case 'remove': {
          if (!op.id) {
            logger.warn(`[Remember] remove操作缺少id`)
            continue
          }
          const isFragment = op.id.startsWith('frag-')
          const isLongTerm = op.id.startsWith('ltm-')

          if (!isFragment && !isLongTerm) {
            logger.warn(`[Remember] 无效的记忆ID: ${op.id}`)
            continue
          }

          let success: boolean
          if (isFragment) {
            success = await jsonMemoryManager.deleteFragmentMemory(op.id)
          } else {
            success = await jsonMemoryManager.deleteLongTermMemory(op.id)
          }

          if (success) {
            logger.info(`[Remember] 删除记忆: ${op.id}`)
          } else {
            logger.warn(`[Remember] 未找到要删除的记忆: ${op.id}`)
          }
          break
        }
        case 'update': {
          if (!op.id) {
            logger.warn(`[Remember] update操作缺少id`)
            continue
          }
          if (!op.content && op.importance === undefined) {
            logger.warn(`[Remember] update操作缺少content和importance`)
            continue
          }

          const isFragment = op.id.startsWith('frag-')
          const isLongTerm = op.id.startsWith('ltm-')

          if (!isFragment && !isLongTerm) {
            logger.warn(`[Remember] 无效的记忆ID: ${op.id}`)
            continue
          }

          let success: boolean
          if (isFragment) {
            success = await jsonMemoryManager.updateFragmentMemory(op.id, {
              description: op.content,
              importance: op.importance,
            })
          } else {
            success = await jsonMemoryManager.updateLongTermMemory(op.id, {
              description: op.content,
              importance: op.importance,
            })
          }

          if (success) {
            logger.info(`[Remember] 更新记忆: ${op.id}`)
          } else {
            logger.warn(`[Remember] 未找到要更新的记忆: ${op.id}`)
          }
          break
        }
        default:
          logger.warn(`[Remember] 未知的操作类型: ${(op as any).action}`)
      }
    } catch (error) {
      logger.error(`[Remember] 操作失败: ${(error as Error).message}`)
    }
  }
}

/**
 * 保存笔记审计文件
 * 使用时间戳作为文件名，存储到remember/notes目录
 * @param notes 会话笔记内容
 */
const saveNotesAuditFile = async (notes: SessionNotes): Promise<void> => {
  try {
    const notesDir = join(paths.WORKSPACE_ROOT, 'context', 'remember', 'notes')

    // 确保目录存在
    if (!existsSync(notesDir)) {
      await mkdir(notesDir, { recursive: true })
    }

    const timestamp = Date.now()
    const fileName = `${timestamp}.json`
    const filePath = join(notesDir, fileName)

    const content = {
      timestamp,
      createdAt: new Date().toISOString(),
      notes,
    }

    await writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8')
    logger.info(`[会话笔记] 审计文件已保存: ${filePath}`)
  } catch (error) {
    logger.error(`[会话笔记] 保存审计文件失败: ${(error as Error).message}`)
  }
}

/**
 * 应用任务技能绑定
 * 将 LLM 识别的技能绑定到对应任务
 */
export const applyTaskSkillBindings = async (bindings: TaskSkillBinding[]): Promise<void> => {
  for (const binding of bindings) {
    // 过滤掉空的 taskId
    if (!binding.taskId || binding.taskId.trim() === '') {
      logger.warn(`[会话笔记] 技能绑定跳过，taskId 为空`)
      continue
    }

    // 处理新的skills数组格式
    if (!binding.skills || binding.skills.length === 0) {
      continue
    }

    for (const skillName of binding.skills) {
      try {
        // 技能内容需要从某处获取，这里简化处理，传入空字符串
        // 实际场景中可能需要从技能管理器获取完整内容
        await taskManager.attachSkill(binding.taskId, skillName, '')
        logger.info(`[会话笔记] 技能 ${skillName} 已绑定到任务 ${binding.taskId}`)
      } catch (error) {
        logger.warn(`[会话笔记] 技能绑定失败 ${skillName}: ${(error as Error).message}`)
      }
    }
  }
}

/**
 * 验证LLM提名的场景边界是否有结构性证据支撑
 * @param boundary LLM提名的场景边界
 * @param summaryMessages 本次摘要的消息列表
 * @returns 是否确认边界有效
 */
const verifySceneBoundary = (boundary: SceneBoundary, summaryMessages: BaseMessage[]): boolean => {
  if (!boundary.hasTransition || !boundary.transitionId) return false

  // 查找transitionId对应的消息索引
  const idx = summaryMessages.findIndex((m) => m.id === boundary.transitionId)
  if (idx < 0) {
    logger.warn(`[场景边界验证] 未找到transitionId对应的消息: ${boundary.transitionId}`)
    return false
  }

  const windowSize = configManager.get('SCENE_BOUNDARY_WINDOW_SIZE')
  const densityJumpThreshold = configManager.get('SCENE_BOUNDARY_TOOL_DENSITY_JUMP')
  const timeGapSeconds = configManager.get('SCENE_BOUNDARY_TIME_GAP_SECONDS')

  // 验证器1：工具密度跳变
  const beforeStart = Math.max(0, idx - windowSize)
  const afterEnd = Math.min(summaryMessages.length, idx + windowSize)
  const beforeWindow = summaryMessages.slice(beforeStart, idx)
  const afterWindow = summaryMessages.slice(idx, afterEnd)

  const beforeToolDensity =
    beforeWindow.length > 0
      ? beforeWindow.filter((m) => ToolMessage.isInstance(m)).length / beforeWindow.length
      : 0
  const afterToolDensity =
    afterWindow.length > 0
      ? afterWindow.filter((m) => ToolMessage.isInstance(m)).length / afterWindow.length
      : 0
  const densityJump = Math.abs(afterToolDensity - beforeToolDensity)
  const densityJumpConfirmed = densityJump >= densityJumpThreshold

  // 验证器2：时间间隔
  let timeGapConfirmed = false
  if (idx > 0 && idx < summaryMessages.length) {
    const beforeMsg = summaryMessages[idx - 1]
    const afterMsg = summaryMessages[idx]
    const beforeTime = (beforeMsg as any).timestamp as number | undefined
    const afterTime = (afterMsg as any).timestamp as number | undefined
    if (beforeTime && afterTime) {
      const gapSeconds = (afterTime - beforeTime) / 1000
      timeGapConfirmed = gapSeconds >= timeGapSeconds
    }
  }

  // 验证器3：任务生命周期事件
  const taskEventConfirmed = afterWindow.some((m) => {
    if (!ToolMessage.isInstance(m)) return false
    return m.name === 'create_task' || m.name === 'complete_task'
  })

  const confirmed = densityJumpConfirmed || timeGapConfirmed || taskEventConfirmed

  logger.info(
    `[场景边界验证] LLM提名: id=${boundary.transitionId} idx=${idx} reason="${boundary.reason}" | 密度跳变=${densityJumpConfirmed}(${densityJump.toFixed(2)}) 时间间隔=${timeGapConfirmed} 任务事件=${taskEventConfirmed} → ${confirmed ? '确认' : '否决'}`,
  )

  return confirmed
}

/**
 * 执行场景边界压缩
 * 将边界前的消息替换为摘要笔记，保留重叠窗口
 * @param boundary 已确认的场景边界
 * @param summaryMessages 本次摘要的消息列表
 */
const applySceneBoundaryCompression = (
  boundary: SceneBoundary,
  summaryMessages: BaseMessage[],
): void => {
  const overlapRounds = configManager.get('SCENE_BOUNDARY_OVERLAP_ROUNDS')

  // 查找transitionId对应的消息索引
  const transitionIdx = summaryMessages.findIndex((m) => m.id === boundary.transitionId)
  if (transitionIdx < 0) {
    logger.warn(`[场景边界压缩] 未找到transitionId对应的消息: ${boundary.transitionId}`)
    return
  }

  // 计算保留的起始位置：从边界点往前保留overlapRounds轮
  let keepFromIdx = transitionIdx
  let roundsKept = 0
  for (let i = transitionIdx - 1; i >= 0 && roundsKept < overlapRounds; i--) {
    keepFromIdx = i
    if (HumanMessage.isInstance(summaryMessages[i])) roundsKept++
  }

  const allBufferMessages = BUFFER_WINDOW_CONTEXT.getMessages()
  const boundaryMsgId = summaryMessages[keepFromIdx]?.id

  // 在BufferMessage中找到对应位置
  const bufferCutIdx = allBufferMessages.findIndex((m) => m.id === boundaryMsgId)
  if (bufferCutIdx <= 0) {
    logger.warn(`[场景边界压缩] 未在BufferMessage中找到边界消息，跳过压缩`)
    return
  }

  // 计算被丢弃的消息和tokens
  const removedMessages = allBufferMessages.slice(0, bufferCutIdx)
  const removedCount = removedMessages.length
  const removedTokens = MessageTokenCounter.countMessages(removedMessages)

  // 保留边界后的消息
  const remainingMessages = allBufferMessages.slice(bufferCutIdx)

  BUFFER_WINDOW_CONTEXT.update(remainingMessages)
  BUFFER_WINDOW_CONTEXT.renewCounter()

  logger.info(
    `[场景边界压缩] 已执行：移除 ${removedCount} 条旧消息(${removedTokens} tokens)，保留 ${remainingMessages.length} 条，重叠 ${roundsKept} 轮`,
  )
}

const waitSummaryChunkArray: MessageTokenCounter[] = []
let processing = false
let lastSessionNotesContent: string = ''

/**
 * 广播摘要事件到前端
 */
const broadcastSummaryEvent = (
  type: string,
  data: { beforeTokens: number; afterTokens?: number; savedTokens?: number },
): void => {
  const server = getHybridServer()
  if (server) {
    server.broadcast({
      code: 200,
      message: '',
      type,
      data,
      timestamp: Date.now(),
    })
  }
}

/**
 * 执行单个摘要任务
 */
const processNextSummaryTask = async (): Promise<void> => {
  if (processing) return
  try {
    processing = true
    const messageTokenCounter = waitSummaryChunkArray.pop()
    if (!messageTokenCounter) return

    const { totalTokens } = messageTokenCounter.getCount()

    if (totalTokens === 0) {
      logger.warn('[会话笔记] 无增量消息，跳过')
      return
    }

    // 触发摘要发生前Hook
    await hookManager.emit('beforeSummary' as const, {
      messageCounter: messageTokenCounter,
    })

    // 广播摘要开始事件
    broadcastSummaryEvent(SocketResponseType.SUMMARY_START, { beforeTokens: totalTokens })

    const messages = messageTokenCounter.getMessages()
    const firstMessageId = messages[0]?.id || ''
    const lastMessageId = messages[messages.length - 1]?.id || ''
    logger.info(
      `[会话笔记] 生成笔记，增量token:${totalTokens} 从 ${firstMessageId} 到 ${lastMessageId}`,
    )

    const result = await generateSessionNotes(messages)
    if (!result) return

    // 输出会话笔记全文
    const currentNotesContent = result.notes

    if (currentNotesContent !== lastSessionNotesContent) {
      logger.info(`[会话笔记] 内容变化，新的笔记全文:\n${currentNotesContent}`)
      lastSessionNotesContent = currentNotesContent
    } else {
      logger.info(`[会话笔记] 内容无变化，跳过输出`)
    }

    // 保存审计文件
    await saveNotesAuditFile(result)

    // 执行记忆操作（remember）
    if (result.remember && result.remember.length > 0) {
      logger.info(`[会话笔记] 执行 ${result.remember.length} 个记忆操作`)
      await executeRememberOperations(result.remember)
    }

    // 基于规则的自动清理
    const cleaned = applyRetentionPolicy(BUFFER_WINDOW_CONTEXT.getMessages())
    if (cleaned) {
      logger.info(`[自动清理] 基于规则清理了部分工具rawBody`)
    }

    // 将技能绑定到任务
    await applyTaskSkillBindings(result.taskSkillBindings)

    // 场景边界压缩
    if (result.sceneBoundary && result.sceneBoundary.hasTransition) {
      const confirmed = verifySceneBoundary(result.sceneBoundary, messages)
      if (confirmed) {
        applySceneBoundaryCompression(result.sceneBoundary, messages)
      }
    }

    // 更新session（简化为字符串存储）
    await SESSION_NODE_CONTEXT.updateSessionNode(result.notes, lastMessageId)

    // 计算摘要后的 token 数
    const afterTokens = MessageTokenCounter.countMessages(messages)
    const savedTokens = totalTokens - afterTokens

    // 触发摘要发生后Hook
    await hookManager.emit('afterSummary' as const, {
      messageCounter: messageTokenCounter,
      sessionInfo: {
        summary: SESSION_NODE_CONTEXT.summary,
        lastMessageId,
      },
      summaryResult: result,
    })

    // 广播摘要完成事件
    broadcastSummaryEvent(SocketResponseType.SUMMARY_COMPLETE, {
      beforeTokens: totalTokens,
      afterTokens,
      savedTokens,
    })

    logger.info(`[会话笔记] 生成完成，笔记长度: ${result.notes.length}`)
  } catch (error) {
    logger.error({ error }, `[会话笔记] 生成失败: ${(error as Error).message}`)
  } finally {
    processing = false
    if (waitSummaryChunkArray.length) {
      await processNextSummaryTask()
    }
  }
}

/**
 * 运行会话笔记（异步入口）
 */
export const processSessionMessages = async (
  messageWindows: BaseMessage[],
  chunkSize?: number,
): Promise<void> => {
  const notesTriggerToken = chunkSize ?? configManager.get('NOTES_TRIGGER_TOKEN')
  const summaryChunkArray: MessageTokenCounter[] = []
  while (messageWindows.length > 0) {
    const { selected: currentMessages, remaining: nextMessages } = MessageTokenCounter.truncate(
      messageWindows,
      notesTriggerToken,
      'start',
    )

    const currentChunkCounter = new MessageTokenCounter()
    currentChunkCounter.addMessages(currentMessages)
    summaryChunkArray.push(currentChunkCounter)
    messageWindows = nextMessages
  }
  const newSummaryChunkArray: MessageTokenCounter[] = []
  const mergeToken = notesTriggerToken / 2

  // 执行合并操作
  for (let i = summaryChunkArray.length - 1; i >= 0; i--) {
    const { truncatedTokens } = summaryChunkArray[i].getCount()
    if (truncatedTokens >= notesTriggerToken) {
      newSummaryChunkArray.push(summaryChunkArray[i])
      continue
    }
    // 合并进前一个
    if (truncatedTokens < mergeToken) {
      if (i > 0) {
        // 向前合并
        summaryChunkArray[i - 1].addMessages(summaryChunkArray[i].getMessages())
      } else {
        // 独自成对
        newSummaryChunkArray.push(summaryChunkArray[i])
      }
    } else {
      // 独自成对
      newSummaryChunkArray.push(summaryChunkArray[i])
    }
  }

  waitSummaryChunkArray.push(...newSummaryChunkArray)
  logger.info(`新增[${newSummaryChunkArray.length}]个摘要任务`)
  // 唤起下一个任务的处理
  processNextSummaryTask()
}

/**
 * 检查并运行会话笔记
 */
export const checkAndRunSessionNotes = async (): Promise<void> => {
  // 检查常规对话触发条件
  if (shouldTriggerNotes()) {
    const messages = BUFFER_WINDOW_CONTEXT.renewCounter()
    const messageWindows = messages.getMessages()
    await processSessionMessages(messageWindows)
  }
}

export const waitAllQueue = async (): Promise<void> => {
  while (waitSummaryChunkArray.length > 0 || processing) {
    await processNextSummaryTask()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
