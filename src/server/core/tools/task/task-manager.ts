/**
 * 任务管理模块（简化版）
 * 通过JSON文件进行数据管理，支持并发控制
 *
 * 简化说明：
 * - 去掉父子任务层级
 * - 状态简化为 pending/done 两种
 * - 去掉 order 排序
 * - 保留 notes（任务笔记）
 * - 保留 attachedSkills（内部使用，技能挂载）
 */

import { readFile, writeFile, access, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { paths } from '../../../config/env'
import { logger } from '../../../utils/logger'

/** 任务状态 */
export type TaskStatus = 'pending' | 'done'

/** 任务笔记类型 */
export type NoteType = 'requirement' | 'knowledge' | 'decision' | 'note'

/** 任务笔记 */
export interface TaskNote {
  type: NoteType
  content: string
  timestamp: number
}

/** 任务数据结构 */
export interface Task {
  /** 任务唯一标识（任务名称） */
  id: string
  /** 任务描述 */
  description: string
  /** 任务状态 */
  status: TaskStatus
  /** 预计截止时间 */
  deadline?: string
  /** 记录时间 */
  createdAt: number
  /** 最后更新时间 */
  updatedAt: number
  /** 任务笔记 */
  notes?: TaskNote[]
  /** 关联的技能完整内容（内部使用，摘要系统自动挂载） */
  attachedSkills?: Record<string, string>
}

/** 任务数据根结构 */
export interface TaskData {
  /** 所有任务列表 */
  tasks: Task[]
}

/** 创建任务结果 */
export interface CreateTaskResult {
  success: boolean
  message: string
  task?: Task
}

/** 更新任务状态结果 */
export interface UpdateTaskResult {
  success: boolean
  message: string
}

/** 任务查询结果 */
export interface QueryTaskResult {
  success: boolean
  message: string
  tasks?: Task[]
}

/**
 * 任务管理器类
 * 负责任务的CRUD操作和状态流转
 */
export class TaskManager {
  private data: TaskData | null = null
  private saveLock: Promise<void> = Promise.resolve()
  private readonly tasksFilePath: string
  private broadcastCallback: ((event: string, data: unknown) => void) | null = null

  constructor() {
    this.tasksFilePath = path.join(paths.WORKSPACE_ROOT, 'context', 'tasks.json')
  }

  setBroadcastCallback(callback: (event: string, data: unknown) => void): void {
    this.broadcastCallback = callback
  }

  private broadcast(event: string, data: unknown): void {
    if (this.broadcastCallback) {
      this.broadcastCallback(event, data)
    }
  }

  /**
   * 确保状态目录存在
   */
  private async ensureStateDir(): Promise<void> {
    const stateDir = path.dirname(this.tasksFilePath)
    try {
      await access(stateDir)
    } catch {
      await mkdir(stateDir, { recursive: true })
      logger.info('[TaskManager] 创建任务状态目录')
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
   * 加载任务数据
   */
  private async loadData(): Promise<TaskData> {
    if (this.data) {
      return this.data
    }

    try {
      await access(this.tasksFilePath)
      const content = await readFile(this.tasksFilePath, 'utf-8')
      this.data = JSON.parse(content) as TaskData
      logger.debug('[TaskManager] 任务数据加载成功')
    } catch {
      this.data = { tasks: [] }
      await this.saveData()
      logger.info('[TaskManager] 初始化空任务数据')
    }

    return this.data
  }

  /**
   * 保存任务数据（带并发控制）
   */
  private async saveData(): Promise<void> {
    if (!this.data) return

    this.saveLock = this.saveLock.then(async () => {
      try {
        await this.ensureStateDir()
        await this.atomicWriteFile(this.tasksFilePath, JSON.stringify(this.data, null, 2))
        logger.debug('[TaskManager] 任务数据已保存')
      } catch (error) {
        logger.error({ error }, '[TaskManager] 保存任务数据失败')
        throw error
      }
    })

    await this.saveLock
  }

  /**
   * 根据ID查找任务
   */
  private findTask(taskId: string, tasks: Task[]): Task | undefined {
    return tasks.find((t) => t.id === taskId)
  }

  /**
   * 批量创建任务
   * @param tasks 任务列表
   */
  async createTasks(
    tasks: Array<{
      name: string
      description: string
      deadline?: string
    }>,
  ): Promise<CreateTaskResult[]> {
    const results: CreateTaskResult[] = []

    for (const taskInput of tasks) {
      try {
        const data = await this.loadData()
        const now = Date.now()

        // 检查任务是否已存在（且不是 done 状态）
        const existingTask = data.tasks.find((t) => t.id === taskInput.name)
        if (existingTask && existingTask.status !== 'done') {
          results.push({
            success: false,
            message: `任务 "${taskInput.name}" 已存在且未完成`,
          })
          continue
        }

        // 如果存在已完成的同名任务，删除它
        if (existingTask && existingTask.status === 'done') {
          data.tasks = data.tasks.filter((t) => t.id !== taskInput.name)
        }

        const task: Task = {
          id: taskInput.name,
          description: taskInput.description,
          status: 'pending',
          deadline: taskInput.deadline,
          createdAt: now,
          updatedAt: now,
          notes: [],
          attachedSkills: {},
        }

        data.tasks.push(task)
        await this.saveData()

        logger.info(`[TaskManager] 创建任务: ${taskInput.name}`)
        this.broadcast('task:updated', { tasks: data.tasks })

        results.push({
          success: true,
          message: `任务 "${taskInput.name}" 创建成功`,
          task,
        })
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        logger.error({ error }, '[TaskManager] 创建任务失败')
        results.push({
          success: false,
          message: `创建任务失败: ${err.message}`,
        })
      }
    }

    return results
  }

  /**
   * 更新任务状态
   * @param taskId 任务ID
   * @param newStatus 新状态
   */
  async updateTaskStatus(taskId: string, newStatus: TaskStatus): Promise<UpdateTaskResult> {
    try {
      const data = await this.loadData()
      const task = this.findTask(taskId, data.tasks)

      if (!task) {
        return { success: false, message: `任务 "${taskId}" 不存在` }
      }

      if (task.status === 'done') {
        return { success: false, message: `任务 "${taskId}" 已完成，无法变更状态` }
      }

      const now = Date.now()
      task.status = newStatus
      task.updatedAt = now

      await this.saveData()
      logger.info(`[TaskManager] 任务 "${taskId}" 状态更新为 ${newStatus}`)
      this.broadcast('task:updated', { tasks: data.tasks })

      return {
        success: true,
        message: `任务 "${taskId}" 已${newStatus === 'done' ? '完成' : '开启'}`,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskManager] 更新任务状态失败')
      return { success: false, message: `更新任务状态失败: ${err.message}` }
    }
  }

  /**
   * 查询任务列表
   * @param includeDone 是否包含已完成的任务
   */
  async queryTasks(includeDone = false): Promise<QueryTaskResult> {
    try {
      const data = await this.loadData()
      let tasks = data.tasks

      if (!includeDone) {
        tasks = tasks.filter((t) => t.status !== 'done')
      }

      // 按创建时间排序
      tasks.sort((a, b) => b.createdAt - a.createdAt)

      return {
        success: true,
        message: `查询成功，共 ${tasks.length} 个任务`,
        tasks,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskManager] 查询任务失败')
      return { success: false, message: `查询任务失败: ${err.message}` }
    }
  }

  /**
   * 删除任务
   * @param taskId 任务ID
   */
  async deleteTask(taskId: string): Promise<UpdateTaskResult> {
    try {
      const data = await this.loadData()
      const taskIndex = data.tasks.findIndex((t) => t.id === taskId)

      if (taskIndex === -1) {
        return { success: false, message: `任务 "${taskId}" 不存在` }
      }

      data.tasks.splice(taskIndex, 1)
      await this.saveData()

      logger.info(`[TaskManager] 删除任务 "${taskId}"`)
      this.broadcast('task:updated', { tasks: data.tasks })

      return {
        success: true,
        message: `任务 "${taskId}" 已删除`,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskManager] 删除任务失败')
      return { success: false, message: `删除任务失败: ${err.message}` }
    }
  }

  /**
   * 获取任务详情
   */
  async getTaskDetail(taskId: string): Promise<Task | null> {
    const data = await this.loadData()
    return this.findTask(taskId, data.tasks) || null
  }

  /**
   * 添加任务笔记
   * @param taskId 任务ID
   * @param type 笔记类型
   * @param content 笔记内容
   */
  async addNote(taskId: string, type: NoteType, content: string): Promise<void> {
    const data = await this.loadData()
    const task = this.findTask(taskId, data.tasks)

    if (!task) {
      logger.warn(`[TaskManager] 添加笔记失败，任务 "${taskId}" 不存在`)
      return
    }

    if (task.status === 'done') {
      logger.warn(`[TaskManager] 添加笔记失败，任务 "${taskId}" 已完成，不允许添加笔记`)
      return
    }

    if (!task.notes) {
      task.notes = []
    }

    task.notes.push({
      type,
      content,
      timestamp: Date.now(),
    })
    task.updatedAt = Date.now()

    await this.saveData()
    logger.info(`[TaskManager] 任务 "${taskId}" 添加笔记，类型: ${type}`)
  }

  /**
   * 挂载技能到任务（内部使用，摘要系统调用）
   */
  async attachSkill(taskId: string, skillName: string, skillContent: string): Promise<void> {
    const data = await this.loadData()
    const task = this.findTask(taskId, data.tasks)

    if (!task) {
      logger.warn(`[TaskManager] 挂载技能失败，任务 "${taskId}" 不存在`)
      return
    }

    if (!task.attachedSkills) {
      task.attachedSkills = {}
    }

    task.attachedSkills[skillName] = skillContent
    task.updatedAt = Date.now()

    await this.saveData()
    logger.info(`[TaskManager] 任务 "${taskId}" 挂载技能: ${skillName}`)
  }

  /**
   * 获取任务关联的技能
   */
  async getAttachedSkills(taskId: string): Promise<Record<string, string>> {
    const data = await this.loadData()
    const task = this.findTask(taskId, data.tasks)

    if (!task) {
      return {}
    }

    return task.attachedSkills || {}
  }

  /**
   * 清空任务关联的技能（内部使用）
   */
  async clearAttachedSkills(taskId: string): Promise<void> {
    const data = await this.loadData()
    const task = this.findTask(taskId, data.tasks)
    if (task) {
      task.attachedSkills = {}
      task.updatedAt = Date.now()
      await this.saveData()
      logger.info(`[TaskManager] 任务 "${taskId}" 的 attachedSkills 已清空`)
    }
  }

  /**
   * 是否有进行中的任务（status = pending）
   */
  async hasActiveTask(): Promise<boolean> {
    const data = await this.loadData()
    return data.tasks.some((t) => t.status === 'pending')
  }

  /**
   * 获取第一个进行中的任务
   */
  async getActiveTask(): Promise<Task | null> {
    const data = await this.loadData()
    const pendingTasks = data.tasks.filter((t) => t.status === 'pending')
    return pendingTasks.length > 0 ? pendingTasks[0] : null
  }
}

// 导出单例
export const taskManager = new TaskManager()
