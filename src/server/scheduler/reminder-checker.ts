/**
 * 提醒检查器
 * 定时检查提醒事项，触发预提醒和正式提醒
 */

import { scheduler } from '../scheduler'
import { reminderManager, type Reminder } from '../core/tools/todo/todo-manager'
import { messageProcessor } from '../core/graph/message-processor'
import { logger } from '../utils/logger'

/** 触发时间窗口（毫秒），2分钟 */
const TRIGGER_WINDOW_MS = 2 * 60 * 1000

/**
 * 检查提醒事项
 */
async function checkReminders(): Promise<void> {
  try {
    const reminders = await reminderManager.getPendingReminders()
    const now = Date.now()

    for (const reminder of reminders) {
      await checkReminder(reminder, now)
    }
  } catch (error) {
    logger.error({ error }, '[ReminderChecker] 检查提醒失败')
  }
}

/**
 * 检查单个提醒
 */
async function checkReminder(reminder: Reminder, now: number): Promise<void> {
  // 检查预提醒
  if (reminder.preRemindTime && !reminder.preRemindTriggered) {
    if (now >= reminder.preRemindTime) {
      await triggerPreReminder(reminder, now)
    }
  }

  // 检查正式触发
  const timeDiff = Math.abs(now - reminder.triggerTime)
  if (timeDiff <= TRIGGER_WINDOW_MS && now >= reminder.triggerTime - TRIGGER_WINDOW_MS) {
    await triggerReminder(reminder)
    return
  }

  // 检查是否错过
  if (now > reminder.triggerTime + TRIGGER_WINDOW_MS) {
    await markAsMissed(reminder)
  }
}

/**
 * 触发预提醒
 */
async function triggerPreReminder(reminder: Reminder, now: number): Promise<void> {
  const timeDiff = reminder.triggerTime - now
  const minutesLeft = Math.round(timeDiff / 60000)
  const hoursLeft = Math.floor(minutesLeft / 60)
  const remainMinutes = minutesLeft % 60

  let timeText: string
  if (hoursLeft > 0) {
    timeText = `${hoursLeft}小时${remainMinutes > 0 ? remainMinutes + '分钟' : ''}`
  } else {
    timeText = `${minutesLeft}分钟`
  }

  const message = `用户在 ${new Date(reminder.triggerTime).toLocaleString()} 需要「${reminder.event}」，还剩 ${timeText}，建议提醒下用户，避免遗忘。`

  await messageProcessor.injectSystemNote(message)
  await reminderManager.markPreRemindTriggered(reminder.id)

  logger.info(`[ReminderChecker] 预提醒触发: ${reminder.event}`)
}

/**
 * 触发正式提醒
 */
async function triggerReminder(reminder: Reminder): Promise<void> {
  const message = `用户现在需要去做「${reminder.event}」。`

  await messageProcessor.injectSystemNote(message)
  await reminderManager.updateStatus(reminder.id, 'triggered')

  logger.info(`[ReminderChecker] 提醒触发: ${reminder.event}`)
}

/**
 * 标记为错过
 */
async function markAsMissed(reminder: Reminder): Promise<void> {
  const message = `提醒「${reminder.event}」已经错过了（原定时间：${new Date(reminder.triggerTime).toLocaleString()}），请根据重要性自行决定是否要说点什么。`

  await messageProcessor.injectSystemNote(message)
  await reminderManager.updateStatus(reminder.id, 'missed')

  logger.info(`[ReminderChecker] 提醒错过: ${reminder.event}`)
}

/**
 * 启动提醒检查器
 * 每分钟检查一次
 */
export function startReminderChecker(): void {
  scheduler.addJob({
    name: 'reminder-checker',
    cronExpression: '* * * * *', // 每分钟执行
    handler: checkReminders,
    enabled: true,
  })

  logger.info('[ReminderChecker] 提醒检查器已启动')
}

/**
 * 停止提醒检查器
 */
export function stopReminderChecker(): void {
  const jobs = scheduler.getAllJobs()
  const checkerJob = jobs.find((j) => j.name === 'reminder-checker')
  if (checkerJob) {
    scheduler.removeJob(checkerJob.id)
    logger.info('[ReminderChecker] 提醒检查器已停止')
  }
}
