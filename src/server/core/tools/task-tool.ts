/**
 * 任务管理工具（简化版）
 *
 * 简化说明：
 * - 工具名称更口语化：create_tasks, update_task, list_tasks, delete_task, add_note
 * - 状态简化为 pending/done
 * - 去掉父子层级、order 排序
 * - 保留笔记记录功能
 * - 技能挂载仅内部使用，不暴露工具
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { taskManager, TaskStatus } from './task/task-manager'
import { logger } from '../../utils/logger'
import { ToolResult } from '../../utils/tool-response'

/**
 * 批量创建任务工具
 * 简单任务不需要创建，复杂任务再创建
 */
export const createTaskTool = new DynamicStructuredTool({
  name: 'create_tasks',
  description: `批量创建任务。

**使用场景：**
- 用户要求完成一个可能需要多轮才能完成的复杂任务时
- 需要跟踪任务进度时

**示例：**
- 批量创建：{"tasks": [
    {"name": "开发用户模块", "description": "实现用户相关的所有功能"},
    {"name": "测试登录功能", "description": "编写用户登录接口"}
  ]}

**注意：**
- 简单任务（1-2轮可完成）不需要创建任务
- 任务名称作为唯一标识，不能重复`,
  schema: z.object({
    tasks: z
      .array(
        z.object({
          name: z.string().describe('任务名称（唯一标识）'),
          description: z.string().describe('任务详细描述'),
          deadline: z.string().optional().describe('预计截止时间'),
        }),
      )
      .min(1)
      .describe('任务列表'),
  }),
  func: async (input) => {
    const toolName = 'create_tasks'
    try {
      const results = await taskManager.createTasks(input.tasks)

      const successCount = results.filter((r) => r.success).length
      const failCount = results.length - successCount

      if (failCount === 0) {
        return await ToolResult.success(toolName, {
          msg: `成功创建 ${successCount} 个任务`,
          extra: {
            tasks: results.map((r) => r.task?.id),
          },
        })
      } else {
        return await ToolResult.success(toolName, {
          msg: `创建完成：成功 ${successCount} 个，失败 ${failCount} 个`,
          extra: { results },
        })
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskTool] 创建任务失败')
      return await ToolResult.error(toolName, {
        msg: '创建任务失败',
        body: err.message,
      })
    }
  },
})

/**
 * 更新任务状态工具
 * 用于开启任务或标记完成
 */
export const updateTaskStatusTool = new DynamicStructuredTool({
  name: 'update_task',
  description: `更新任务状态，支持开启任务、标记完成。

**状态说明：**
- pending: 待执行
- done: 已完成

**示例：**
- 开启任务：{"taskId": "实现登录API", "status": "pending"}
- 标记完成：{"taskId": "实现登录API", "status": "done"}`,
  schema: z.object({
    taskId: z.string().describe('任务ID（即任务名称）'),
    status: z.enum(['pending', 'done']).describe('新状态'),
  }),
  func: async (input) => {
    const toolName = 'update_task'
    try {
      const result = await taskManager.updateTaskStatus(input.taskId, input.status as TaskStatus)
      if (!result.success) {
        return await ToolResult.error(toolName, {
          msg: result.message,
          extra: {
            taskId: input.taskId,
            status: input.status,
          },
        })
      }
      return await ToolResult.success(toolName, {
        msg: result.message,
        extra: {
          taskId: input.taskId,
          status: input.status,
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskTool] 更新任务失败')
      return await ToolResult.error(toolName, {
        msg: '更新任务失败',
        body: err.message,
      })
    }
  },
})

/**
 * 查询任务工具
 * 用于查看任务列表
 */
export const queryTasksTool = new DynamicStructuredTool({
  name: 'list_tasks',
  description: `查询任务列表，查看当前任务状态。`,
  schema: z.object({
    includeDone: z.boolean().optional().describe('是否包含已完成的任务，默认false'),
  }),
  func: async (input) => {
    const toolName = 'list_tasks'
    try {
      const result = await taskManager.queryTasks(input.includeDone)

      if (!result.success || !result.tasks) {
        return await ToolResult.error(toolName, {
          msg: result.message || '查询任务失败',
        })
      }

      const lines: string[] = []
      lines.push(result.message)
      lines.push('')

      // 显示任务列表
      for (const task of result.tasks) {
        const statusIcon = task.status === 'done' ? '✓' : '○'
        lines.push(`${statusIcon} ${task.id} (${task.status})`)
        lines.push(`  ${task.description}`)
        if (task.deadline) {
          lines.push(`  截止: ${task.deadline}`)
        }
        if (task.notes && task.notes.length > 0) {
          lines.push(`  笔记: ${task.notes.length} 条`)
        }
        lines.push('')
      }

      const output = lines.join('\n')

      return await ToolResult.success(toolName, {
        msg: '查询任务成功',
        body: output,
        extra: {
          totalTasks: result.tasks.length,
          tasks: result.tasks.map((t) => ({
            id: t.id,
            description: t.description,
            status: t.status,
            deadline: t.deadline,
            noteCount: t.notes?.length || 0,
          })),
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskTool] 查询任务失败')
      return await ToolResult.error(toolName, {
        msg: '查询任务失败',
        body: err.message,
      })
    }
  },
})

/**
 * 删除任务工具
 */
export const deleteTaskTool = new DynamicStructuredTool({
  name: 'delete_task',
  description: `删除指定的废弃任务。`,
  schema: z.object({
    taskId: z.string().describe('任务ID'),
  }),
  func: async (input) => {
    const toolName = 'delete_task'
    try {
      const result = await taskManager.deleteTask(input.taskId)
      if (!result.success) {
        return await ToolResult.error(toolName, {
          msg: result.message,
          extra: {
            taskId: input.taskId,
          },
        })
      }
      return await ToolResult.success(toolName, {
        msg: result.message,
        extra: {
          taskId: input.taskId,
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskTool] 删除任务失败')
      return await ToolResult.error(toolName, {
        msg: '删除任务失败',
        body: err.message,
      })
    }
  },
})

/**
 * 添加任务笔记工具
 */
export const addTaskNoteTool = new DynamicStructuredTool({
  name: 'add_note',
  description:
    '向当前任务添加笔记，用于记录需求、经验、决策或备注。摘要时这些信息会被保留，不会被遗忘。',
  schema: z.object({
    taskId: z.string().describe('任务 ID'),
    type: z.enum(['requirement', 'knowledge', 'decision', 'note']).describe('笔记类型'),
    content: z.string().describe('笔记内容'),
  }),
  func: async ({ taskId, type, content }) => {
    const toolName = 'add_note'
    try {
      await taskManager.addNote(taskId, type, content)
      return await ToolResult.success(toolName, {
        msg: `已添加 ${type} 到任务 ${taskId}`,
        body: content,
        extra: {
          taskId,
          noteType: type,
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[TaskTool] 添加笔记失败')
      return await ToolResult.error(toolName, {
        msg: '添加笔记失败',
        body: err.message,
        extra: {
          taskId,
          noteType: type,
        },
      })
    }
  },
})

/**
 * 任务工具集合（5个工具）
 */
export const taskTools = [
  createTaskTool,
  updateTaskStatusTool,
  queryTasksTool,
  deleteTaskTool,
  addTaskNoteTool,
]
