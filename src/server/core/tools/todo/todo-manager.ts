/**
 * 定时提醒管理模块
 * 用于管理用户的时间提醒事项，支持预提醒和错过处理
 */

import { readFile, writeFile, access, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { paths } from '../../../config/env'
import { logger } from '../../../utils/logger'

/** 提醒状态 */
export type ReminderStatus = 'pending' | 'triggered' | 'missed'

/** 提醒数据结构 */
export interface Reminder {
  /** 唯一标识 */
  id: string
  /** 事件内容 */
  event: string
  /** 触发时间（绝对时间，毫秒时间戳） */
  triggerTime: number
  /** 预提醒时间（绝对时间，毫秒时间戳，可选） */
  preRemindTime?: number
  /** 预提醒是否已触发 */
  preRemindTriggered: boolean
  /** 状态 */
  status: ReminderStatus
  /** 创建时间 */
  createdAt: number
}

/** 提醒数据根结构 */
export interface ReminderData {
  /** 所有提醒列表 */
  reminders: Reminder[]
  /** 下一个ID */
  nextId: number
}

/** 创建提醒结果 */
export interface CreateReminderResult {
  success: boolean
  message: string
  reminder?: Reminder
}

/** 查询提醒结果 */
export interface QueryReminderResult {
  success: boolean
  message: string
  reminders?: Reminder[]
}

/**
 * 定时提醒管理器类
 * 负责提醒的CRUD操作和状态管理
 */
export class ReminderManager {
  private data: ReminderData | null = null
  private saveLock: Promise<void> = Promise.resolve()
  private readonly filePath: string
  private broadcastCallback: ((event: string, data: unknown) => void) | null = null

  constructor() {
    this.filePath = path.join(paths.WORKSPACE_ROOT, 'db', 'reminders.json')
  }

  /**
   * 设置广播回调
   */
  setBroadcastCallback(callback: (event: string, data: unknown) => void): void {
    this.broadcastCallback = callback
  }

  /**
   * 广播事件
   */
  private broadcast(event: string, data: unknown): void {
    if (this.broadcastCallback) {
      this.broadcastCallback(event, data)
    }
  }

  /**
   * 确保目录存在
   */
  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.filePath)
    try {
      await access(dir)
    } catch {
      await mkdir(dir, { recursive: true })
      logger.info('[ReminderManager] 创建提醒数据目录')
    }
  }

  /**
   * 原子写入文件
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await writeFile(tempPath, content, 'utf-8')
    await rename(tempPath, filePath)
  }

  /**
   * 加载数据
   */
  private async loadData(): Promise<ReminderData> {
    if (this.data) {
      return this.data
    }

    try {
      await access(this.filePath)
      const content = await readFile(this.filePath, 'utf-8')
      this.data = JSON.parse(content) as ReminderData
      logger.debug('[ReminderManager] 提醒数据加载成功')
    } catch {
      this.data = { reminders: [], nextId: 1 }
      await this.saveData()
      logger.info('[ReminderManager] 初始化空提醒数据')
    }

    return this.data
  }

  /**
   * 保存数据（带并发控制）
   */
  private async saveData(): Promise<void> {
    if (!this.data) return

    this.saveLock = this.saveLock.then(async () => {
      try {
        await this.ensureDir()
        await this.atomicWriteFile(this.filePath, JSON.stringify(this.data, null, 2))
        logger.debug('[ReminderManager] 提醒数据已保存')
      } catch (error) {
        logger.error({ error }, '[ReminderManager] 保存提醒数据失败')
        throw error
      }
    })

    await this.saveLock
  }

  /**
   * 创建提醒
   * @param event 事件内容
   * @param triggerTime 触发时间（毫秒时间戳）
   * @param preRemindTime 预提醒时间（毫秒时间戳，可选）
   */
  async createReminder(
    event: string,
    triggerTime: number,
    preRemindTime?: number,
  ): Promise<CreateReminderResult> {
    try {
      const data = await this.loadData()
      const now = Date.now()

      const reminder: Reminder = {
        id: `reminder-${data.nextId}`,
        event,
        triggerTime,
        preRemindTime,
        preRemindTriggered: false,
        status: 'pending',
        createdAt: now,
      }

      data.reminders.push(reminder)
      data.nextId++
      await this.saveData()

      logger.info(
        `[ReminderManager] 创建提醒: ${event}, 触发时间: ${new Date(triggerTime).toLocaleString()}`,
      )
      this.broadcast('reminder:created', { reminder })

      return {
        success: true,
        message: `提醒创建成功，将在 ${new Date(triggerTime).toLocaleString()} 提醒你`,
        reminder,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[ReminderManager] 创建提醒失败')
      return { success: false, message: `创建提醒失败: ${err.message}` }
    }
  }

  /**
   * 删除提醒
   * @param id 提醒ID
   */
  async deleteReminder(id: string): Promise<{ success: boolean; message: string }> {
    try {
      const data = await this.loadData()
      const index = data.reminders.findIndex((r) => r.id === id)

      if (index === -1) {
        return { success: false, message: `提醒 ${id} 不存在` }
      }

      data.reminders.splice(index, 1)
      await this.saveData()

      logger.info(`[ReminderManager] 删除提醒: ${id}`)
      this.broadcast('reminder:deleted', { id })

      return { success: true, message: '提醒已删除' }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[ReminderManager] 删除提醒失败')
      return { success: false, message: `删除提醒失败: ${err.message}` }
    }
  }

  /**
   * 更新提醒状态
   * @param id 提醒ID
   * @param status 新状态
   */
  async updateStatus(id: string, status: ReminderStatus): Promise<void> {
    const data = await this.loadData()
    const reminder = data.reminders.find((r) => r.id === id)

    if (reminder) {
      reminder.status = status
      await this.saveData()
      logger.info(`[ReminderManager] 提醒 ${id} 状态更新为: ${status}`)
    }
  }

  /**
   * 标记预提醒已触发
   * @param id 提醒ID
   */
  async markPreRemindTriggered(id: string): Promise<void> {
    const data = await this.loadData()
    const reminder = data.reminders.find((r) => r.id === id)

    if (reminder) {
      reminder.preRemindTriggered = true
      await this.saveData()
      logger.info(`[ReminderManager] 提醒 ${id} 预提醒已触发`)
    }
  }

  /**
   * 查询提醒列表
   * @param includeTriggered 是否包含已触发的
   * @param includeMissed 是否包含已错过的
   */
  async queryReminders(
    includeTriggered = false,
    includeMissed = false,
  ): Promise<QueryReminderResult> {
    try {
      const data = await this.loadData()
      let reminders = data.reminders

      if (!includeTriggered) {
        reminders = reminders.filter((r) => r.status !== 'triggered')
      }
      if (!includeMissed) {
        reminders = reminders.filter((r) => r.status !== 'missed')
      }

      reminders.sort((a, b) => a.triggerTime - b.triggerTime)

      return {
        success: true,
        message: `查询成功，共 ${reminders.length} 个提醒`,
        reminders,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[ReminderManager] 查询提醒失败')
      return { success: false, message: `查询提醒失败: ${err.message}` }
    }
  }

  /**
   * 获取需要检查的提醒列表（pending状态）
   */
  async getPendingReminders(): Promise<Reminder[]> {
    const data = await this.loadData()
    return data.reminders.filter((r) => r.status === 'pending')
  }

  /**
   * 获取提醒详情
   * @param id 提醒ID
   */
  async getReminder(id: string): Promise<Reminder | null> {
    const data = await this.loadData()
    return data.reminders.find((r) => r.id === id) || null
  }
}

export const reminderManager = new ReminderManager()
