/**
 * 定时提醒工具
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { reminderManager } from './todo/todo-manager'
import { logger } from '../../utils/logger'
import { ToolResult } from '../../utils/tool-response'

export const createReminderTool = new DynamicStructuredTool({
  name: 'schedule_reminder',
  description: `创建定时提醒。用于"某个时间点提醒我做某事"的场景。

**使用场景：**
- 用户说"X点提醒我..."、"X时间要..."
- 用户提到某个时间点需要做某事
- 需要在特定时间提醒用户

**参数说明：**
- event: 要提醒的事件内容
- triggerTime: 触发时间，格式为 YYYY-MM-DD HH:mm:ss（绝对时间）
- preRemindMinutes: 提前多少分钟预提醒（可选，不填则无预提醒）

**示例：**
- "3点开会" → {"event": "开会", "triggerTime": "2024-01-15 15:00:00"}
- "明天早上8点叫我起床" → {"event": "起床", "triggerTime": "2024-01-16 08:00:00", "preRemindMinutes": 5}
- "半小时后提醒我关火" → 需要先获取当前时间，计算出绝对时间后再创建

**重要：**
- 必须使用绝对时间，不能使用"明天"、"半小时后"等相对时间
- 创建前必须先调用 get_current_time 获取当前时间，然后计算绝对时间`,
  schema: z.object({
    event: z.string().describe('要提醒的事件内容'),
    triggerTime: z.string().describe('触发时间，格式：YYYY-MM-DD HH:mm:ss'),
    preRemindMinutes: z.number().optional().describe('提前多少分钟预提醒（可选）'),
  }),
  func: async (input) => {
    const toolName = 'schedule_reminder'
    try {
      const { event, triggerTime, preRemindMinutes } = input

      const triggerDate = new Date(triggerTime)
      if (isNaN(triggerDate.getTime())) {
        return await ToolResult.error(toolName, {
          msg: '时间格式错误',
          body: '请使用 YYYY-MM-DD HH:mm:ss 格式',
        })
      }

      const triggerTimestamp = triggerDate.getTime()
      const now = Date.now()

      if (triggerTimestamp < now) {
        return await ToolResult.error(toolName, {
          msg: '时间已过',
          body: '触发时间不能早于当前时间',
        })
      }

      let preRemindTimestamp: number | undefined
      if (preRemindMinutes && preRemindMinutes > 0) {
        preRemindTimestamp = triggerTimestamp - preRemindMinutes * 60 * 1000
      }

      const result = await reminderManager.createReminder(
        event,
        triggerTimestamp,
        preRemindTimestamp,
      )

      if (result.success) {
        const preRemindInfo = preRemindMinutes ? `，将提前 ${preRemindMinutes} 分钟预提醒` : ''
        return await ToolResult.success(toolName, {
          msg: `提醒创建成功${preRemindInfo}`,
          extra: {
            id: result.reminder?.id,
            triggerTime: result.reminder?.triggerTime,
          },
        })
      }

      return await ToolResult.error(toolName, {
        msg: '创建提醒失败',
        body: result.message,
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[ScheduleReminder] 创建提醒失败')
      return await ToolResult.error(toolName, {
        msg: '创建提醒失败',
        body: err.message,
      })
    }
  },
})

export const queryRemindersTool = new DynamicStructuredTool({
  name: 'query_reminders',
  description: `查询定时提醒列表，查看当前有哪些待提醒的事项。`,
  schema: z.object({
    includeTriggered: z.boolean().optional().describe('是否包含已触发的提醒，默认false'),
    includeMissed: z.boolean().optional().describe('是否包含已错过的提醒，默认false'),
  }),
  func: async (input) => {
    const toolName = 'query_reminders'
    try {
      const result = await reminderManager.queryReminders(
        input.includeTriggered,
        input.includeMissed,
      )

      if (!result.success || !result.reminders) {
        return await ToolResult.error(toolName, {
          msg: result.message || '查询提醒失败',
        })
      }

      if (result.reminders.length === 0) {
        return await ToolResult.success(toolName, {
          msg: '当前没有提醒事项',
          extra: { count: 0 },
        })
      }

      const lines: string[] = []
      lines.push(`共有 ${result.reminders.length} 个提醒：`)
      lines.push('')

      for (const reminder of result.reminders) {
        const time = new Date(reminder.triggerTime).toLocaleString()
        const statusText =
          reminder.status === 'pending'
            ? '待触发'
            : reminder.status === 'triggered'
              ? '已触发'
              : '已错过'
        const preRemindText = reminder.preRemindTime
          ? `（预提醒: ${new Date(reminder.preRemindTime).toLocaleString()}）`
          : ''
        lines.push(`- [${statusText}] ${reminder.event} @ ${time}${preRemindText}`)
      }

      return await ToolResult.success(toolName, {
        msg: '查询成功',
        body: lines.join('\n'),
        extra: {
          count: result.reminders.length,
          reminders: result.reminders,
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[QueryReminders] 查询提醒失败')
      return await ToolResult.error(toolName, {
        msg: '查询提醒失败',
        body: err.message,
      })
    }
  },
})

export const deleteReminderTool = new DynamicStructuredTool({
  name: 'delete_reminder',
  description: `删除指定的定时提醒。`,
  schema: z.object({
    id: z.string().describe('提醒ID'),
  }),
  func: async (input) => {
    const toolName = 'delete_reminder'
    try {
      const result = await reminderManager.deleteReminder(input.id)

      if (result.success) {
        return await ToolResult.success(toolName, {
          msg: result.message,
          extra: { id: input.id },
        })
      }

      return await ToolResult.error(toolName, {
        msg: '删除提醒失败',
        body: result.message,
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[DeleteReminder] 删除提醒失败')
      return await ToolResult.error(toolName, {
        msg: '删除提醒失败',
        body: err.message,
      })
    }
  },
})

export const reminderTools = [createReminderTool, queryRemindersTool, deleteReminderTool]
