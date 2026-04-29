import { readdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { paths } from '../config/env'
import { logger, formatDate, retryForever, removeThinkTags } from '../utils'
import { scheduler } from '.'
import { jsonMemoryManager } from '../memory/json-memory-manager'
import { SummarizationModel } from '../core/model'
import { HumanMessage, SystemMessage } from 'langchain'
import type { MemoryMessage } from '../memory'

const MEMORY_DIR = 'memory'
const SUMMARY_FILE = 'memory_summary.txt'
const MEMORY_FILE = 'memory.jsonl'
const COUNT_FILE = 'memory_count.txt'

let summaryJobId: string | null = null
let cleanupJobId: string | null = null

/**
 * 每日摘要提示词
 * 用于记录当天发生的事件、事实、进度和情绪
 * 注意：此摘要仅写入当日文件，不更新人格摘要
 */
const DAILY_SUMMARY_PROMPT = `
你是一名每日总结专家，负责基于"当天全部对话记录 + 历史关键摘要"，生成一份高密度、可复用的每日总结。

你不是七七，也不是任何角色。
你是纯粹的摘要系统。
禁止使用第一人称或任何人格化语言。

【核心规则】
- 输出为"当日完整总结"，不是简单罗列
- 保留对未来有价值的信息，过滤无意义闲聊
- 强调趋势、变化、决策和未完成事项
- 为"下一天延续使用"服务

【必须包含内容】

1. 今日整体情绪状态（最高优先级）
   - 主导情绪（如：开心/焦虑/疲惫/平静等）
   - 情绪变化趋势（如：先焦虑→后缓解）
   - 触发原因（关键事件驱动）
   - 情绪强度总结

2. 今日关键事件
   - 发生了哪些重要事情（按重要性排序）
   - 哪些信息是"新增且重要"的

3. 已完成事项
   - 今天完成了哪些关键任务
   - 有结果/产出的内容

4. 进行中事项
   - 正在推进但未完成的任务
   - 当前进度/卡点

5. 核心目标与方向变化
   - 当前主要目标是什么
   - 是否发生调整/转变

6. 未完成操作链（重点）
   - 明确列出下一步要做的事情
   - 如果是多步骤任务，标出当前所处阶段

7. 重要记忆沉淀
   - 新形成的偏好/约定/规则
   - 对未来有持续影响的信息

8. 风险/问题/隐患
   - 当前存在的问题
   - 可能影响后续的风险点

9. 上下文延续关键点
   - 明天继续时必须知道的信息
   - 任何不能丢失的背景条件

【严格禁止】
- 忽略情绪状态
- 记录无价值闲聊
- 丢失任务链或目标
- 输出流水账（必须有结构和重点）

【输出要求】
- 结构化表达（分点清晰）
- 高信息密度，避免冗余
- 强调"可延续性"和"可执行性"
`

/**
 * 将消息列表转换为文本格式
 * @param messages 消息列表
 * @returns 格式化的消息文本
 */
function formatMessagesText(messages: MemoryMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.type === 'human' ? '用户' : msg.type === 'ai' ? 'AI' : msg.type
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      return `[${role}]: ${content}`
    })
    .join('\n')
}

/**
 * 每日摘要函数
 * 专门用于生成每日摘要，不更新人格摘要，不提取长期记忆
 * 失败后会无限重试直到成功
 * @param dateStr 日期字符串，格式为 'YYYYMMDD'
 * @param messages 当天的消息列表
 * @param currentSummary 当前已有的摘要（用于滚动摘要）
 * @returns 生成的摘要文本
 */
async function DailySummaryFunc(
  dateStr: string,
  messages: MemoryMessage[],
  currentSummary?: string,
): Promise<string> {
  const messagesText = formatMessagesText(messages)

  logger.debug(`[DailySummary] 开始生成每日摘要，共 ${messages.length} 条消息`)

  // 使用无限重试，直到成功为止
  const summaryText = await retryForever(
    async () => {
      const response = await SummarizationModel.invoke([
        new SystemMessage(DAILY_SUMMARY_PROMPT),
        new HumanMessage(`
        以下是${dateStr}的对话记录：
        ${messagesText}
        ${currentSummary ? `已有的摘要：\n${currentSummary}\n\n请整合已有摘要和新对话内容，生成完整的每日摘要。` : '请生成每日摘要。'}
        `),
      ])

      logger.debug(
        `[DailySummary] LLM响应类型: ${typeof response}, content类型: ${typeof response.content}`,
      )

      let result: string
      if (typeof response === 'string') {
        result = response
      } else if (typeof response.content === 'string') {
        result = response.content
      } else {
        result = JSON.stringify(response.content)
      }

      if (!result || result.trim().length === 0) {
        throw new Error('生成的摘要为空')
      }

      return result
    },
    {
      timeoutMs: -1, // 不超时
      delayMs: 5000, // 失败后5秒重试
      onRetry: (attempt, error) => {
        logger.warn(
          { attempt, error: error.message },
          `[DailySummary] 第${attempt}次尝试失败，准备重试...`,
        )
      },
    },
  )

  // 移除think标签内容
  const cleanedSummary = removeThinkTags(summaryText)

  logger.debug(`[DailySummary] 生成的摘要长度: ${cleanedSummary.length}`)
  return cleanedSummary
}

/**
 * 扫描 memory 目录，返回缺失摘要的日期列表
 * @param maxDays 最多检查多少天前的数据，默认7天
 * @returns 缺失摘要的日期字符串数组（格式：YYYYMMDD）
 */
function findDatesWithoutSummary(maxDays: number = 7): string[] {
  const memoryPath = join(paths.WORKSPACE_ROOT, MEMORY_DIR)

  if (!existsSync(memoryPath)) {
    logger.info('[LongTermSummary] memory 目录不存在')
    return []
  }

  const todayStr = formatDate(new Date())
  const datesWithoutSummary: string[] = []

  try {
    const entries = readdirSync(memoryPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dateStr = entry.name

      if (!/^\d{8}$/.test(dateStr)) continue

      if (dateStr === todayStr) continue

      const dayDir = join(memoryPath, dateStr)
      const memoryFile = join(dayDir, MEMORY_FILE)
      const summaryFile = join(dayDir, SUMMARY_FILE)

      if (!existsSync(memoryFile)) continue

      const memoryStat = statSync(memoryFile)
      if (memoryStat.size === 0) continue

      const countFile = join(dayDir, COUNT_FILE)

      // 检查摘要文件是否存在
      if (!existsSync(summaryFile)) {
        datesWithoutSummary.push(dateStr)
        continue
      }

      // 检查摘要文件是否为空
      const summaryStat = statSync(summaryFile)
      if (summaryStat.size === 0) {
        datesWithoutSummary.push(dateStr)
        continue
      }

      // 检查memory文件的最后编辑时间是否晚于摘要文件
      if (memoryStat.mtime > summaryStat.mtime) {
        datesWithoutSummary.push(dateStr)
        continue
      }

      // 检查count文件是否存在
      if (!existsSync(countFile)) {
        datesWithoutSummary.push(dateStr)
        continue
      }

      // 检查count值是否小于消息总数（有未处理的消息）
      const countContent = readFileSync(countFile, 'utf-8')
      const processedCount = parseInt(countContent) || 0
      // 读取memory文件计算实际消息数量（非空行数）
      const memoryContent = readFileSync(memoryFile, 'utf-8')
      const actualMessageCount = memoryContent.split('\n').filter((line) => line.trim()).length
      if (processedCount < actualMessageCount) {
        datesWithoutSummary.push(dateStr)
      }
    }

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxDays)
    const cutoffStr = formatDate(cutoffDate)

    const filteredDates = datesWithoutSummary
      .filter((d) => d >= cutoffStr)
      .sort((a, b) => a.localeCompare(b))

    if (filteredDates.length > 0) {
      logger.info(
        `[LongTermSummary] 发现 ${filteredDates.length} 个缺失摘要的日期: ${filteredDates.join(', ')}`,
      )
    } else {
      logger.debug('[LongTermSummary] 没有缺失摘要的日期')
    }

    return filteredDates
  } catch (error) {
    logger.error({ error }, '[LongTermSummary] 扫描目录失败')
    return []
  }
}

/**
 * 为缺失摘要的日期生成摘要
 * @param dates 需要生成摘要的日期列表
 * @param minMessages 最小消息数阈值，少于此数量不生成摘要
 * @param maxDates 每次最多处理的日期数量，默认1个
 * @param maxWindows 每个日期每次最多处理的摘要窗口数，默认3个
 */
async function generateSummariesForDates(
  dates: string[],
  minMessages: number = 5,
  maxDates: number = 1,
  maxWindows: number = 3,
): Promise<void> {
  if (dates.length === 0) {
    logger.debug('[LongTermSummary] 没有需要处理的日期')
    return
  }

  const datesToProcess = dates.slice(0, maxDates)
  logger.info(`[LongTermSummary] 开始为 ${datesToProcess.length} 个日期生成摘要`)

  for (const dateStr of datesToProcess) {
    try {
      logger.info(`[LongTermSummary] 正在处理 ${dateStr}`)

      const dayDir = join(paths.WORKSPACE_ROOT, MEMORY_DIR, dateStr)
      const memoryFile = join(dayDir, MEMORY_FILE)
      const countFile = join(dayDir, COUNT_FILE)

      // 读取memory.jsonl文件
      const memoryContent = readFileSync(memoryFile, 'utf-8')
      const messages = memoryContent
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch (error: any) {
            logger.error(
              { error: error.message || error, line: line },
              `[LongTermSummary] ${dateStr} 解析消息失败`,
            )
            throw error
          }
        })

      logger.info(`[LongTermSummary] ${dateStr} 共有 ${messages.length} 条消息`)

      // 先定义summaryFile路径，因为后面可能会用到
      const summaryFile = join(dayDir, SUMMARY_FILE)

      if (messages.length < minMessages) {
        logger.info(
          `[LongTermSummary] ${dateStr} 消息数量不足(${messages.length} < ${minMessages})，跳过摘要`,
        )
        // 即使消息不足，也要创建count文件和summary文件，避免重复检查
        writeFileSync(countFile, messages.length.toString(), 'utf-8')
        writeFileSync(summaryFile, '消息数量不足，未生成摘要', 'utf-8')
        logger.info(`[LongTermSummary] ${dateStr} 已标记为处理完成（消息不足）`)
        continue
      }

      // 读取count文件，获取已处理的消息数量
      let processedCount = 0
      if (existsSync(countFile)) {
        const countContent = readFileSync(countFile, 'utf-8')
        processedCount = parseInt(countContent) || 0
        logger.info(
          `[LongTermSummary] ${dateStr} 已处理 ${processedCount}/${messages.length} 条消息`,
        )
      } else {
        logger.info(`[LongTermSummary] ${dateStr} 从头开始处理`)
      }

      // 滚动摘要参数
      const windowSize = 60
      const overlap = 15

      // 读取该日期已有的摘要作为初始摘要
      let accumulatedSummary = ''
      if (existsSync(summaryFile)) {
        accumulatedSummary = readFileSync(summaryFile, 'utf-8').trim()
      }

      // 生成滚动摘要，每次最多处理 maxWindows 个窗口
      let windowCount = 0
      for (
        let i = processedCount;
        i < messages.length && windowCount < maxWindows;
        i += windowSize - overlap
      ) {
        const endIndex = Math.min(i + windowSize, messages.length)
        const windowMessages = messages.slice(i, endIndex)

        if (windowMessages.length < minMessages) {
          break
        }

        windowCount++
        logger.info(
          `[LongTermSummary] 处理 ${dateStr} 的消息 ${i + 1}-${endIndex} (窗口 ${windowCount}/${maxWindows}, 总行数 ${messages.length})`,
        )

        // 调用每日摘要函数进行摘要（内部已无限重试直到成功）
        const summaryText = await DailySummaryFunc(dateStr, windowMessages, accumulatedSummary)

        // 累积摘要
        if (summaryText) {
          accumulatedSummary = summaryText
        }

        // 更新处理计数
        processedCount = endIndex
        writeFileSync(countFile, processedCount.toString(), 'utf-8')

        // 每个窗口成功后立即保存摘要，确保断点续传时不会丢失进度
        if (accumulatedSummary) {
          writeFileSync(summaryFile, accumulatedSummary, 'utf-8')
          logger.debug(`[LongTermSummary] ${dateStr} 窗口 ${windowCount} 摘要已保存`)
        }
      }

      // 循环结束，记录最终状态
      if (accumulatedSummary) {
        logger.info(`[LongTermSummary] ${dateStr} 摘要已完成，共处理 ${processedCount} 条消息`)
      } else {
        logger.warn(`[LongTermSummary] ${dateStr} 摘要内容为空`)
      }

      logger.info(`[LongTermSummary] ${dateStr} 处理完成，已处理 ${processedCount} 条消息`)
    } catch (error: any) {
      logger.error(
        { error: error.message || error, dateStr },
        `[LongTermSummary] ${dateStr} 摘要生成失败，抛出错误以触发重试`,
      )
      // 抛出错误，让上层调度器知道处理失败，从而可以重试
      throw error
    }
  }
}

/**
 * 执行一次摘要检查和生成
 */
async function runSummaryCheck(): Promise<void> {
  const datesWithoutSummary = findDatesWithoutSummary()

  if (datesWithoutSummary.length > 0) {
    logger.info(`[LongTermSummary] 开始执行摘要检查，${datesWithoutSummary.length} 个日期待处理`)
    await generateSummariesForDates(datesWithoutSummary)
  } else {
    logger.debug('[LongTermSummary] 摘要检查完成，没有需要处理的日期')
  }

  await cleanupExpiredMemories()
}

/**
 * 执行记忆清理
 * 自动清理过期的碎片记忆
 */
async function cleanupExpiredMemories(): Promise<void> {
  try {
    // 清理过期碎片记忆
    const deletedCount = await jsonMemoryManager.cleanupExpiredFragments()
    if (deletedCount > 0) {
      logger.info(`[MemoryCleanup] 清理了 ${deletedCount} 条过期碎片记忆`)
    } else {
      logger.debug('[MemoryCleanup] 没有需要清理的过期记忆')
    }
  } catch (error) {
    logger.error({ error }, '[MemoryCleanup] 记忆清理失败')
  }
}

/**
 * 启动长期摘要定时任务
 * @param cronExpression cron 表达式，默认每分钟执行一次
 */
export function startLongTermSummaryScheduler(cronExpression: string = '* * * * *'): void {
  if (summaryJobId) {
    logger.warn('[LongTermSummary] 定时任务已存在，跳过启动')
    return
  }

  summaryJobId = scheduler.addJob({
    name: 'long-term-summary',
    cronExpression,
    handler: runSummaryCheck,
    enabled: true,
  })

  logger.info(`[LongTermSummary] 定时任务已启动，cron: ${cronExpression}`)
}

/**
 * 停止长期摘要定时任务
 */
export function stopLongTermSummaryScheduler(): void {
  if (summaryJobId) {
    scheduler.removeJob(summaryJobId)
    summaryJobId = null
    logger.info('[LongTermSummary] 定时任务已停止')
  }
}

/**
 * 启动记忆清理定时任务
 * @param cronExpression cron 表达式，默认每天执行一次
 */
export function startCleanupScheduler(cronExpression: string = '0 0 * * *'): void {
  if (cleanupJobId) {
    logger.warn('[MemoryCleanup] 定时任务已存在，跳过启动')
    return
  }

  cleanupJobId = scheduler.addJob({
    name: 'memory-cleanup',
    cronExpression,
    handler: cleanupExpiredMemories,
    enabled: true,
  })

  logger.info(`[MemoryCleanup] 定时任务已启动，cron: ${cronExpression}`)
}

/**
 * 停止记忆清理定时任务
 */
export function stopCleanupScheduler(): void {
  if (cleanupJobId) {
    scheduler.removeJob(cleanupJobId)
    cleanupJobId = null
    logger.info('[MemoryCleanup] 定时任务已停止')
  }
}

export { findDatesWithoutSummary, generateSummariesForDates }
