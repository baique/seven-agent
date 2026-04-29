import { BaseMessage, AIMessage } from 'langchain'
import { taskManager } from '../../../tools/task/task-manager'
import { CacheContextBuilder } from '../context-builder'

export class TaskContextBuilder implements CacheContextBuilder {
  cache(): boolean {
    return true
  }
  init(): Promise<void> {
    return Promise.resolve()
  }
  persist(): Promise<void> {
    return Promise.resolve()
  }
  async mountToContext(messages: BaseMessage[]): Promise<void> {
    messages.push(new AIMessage(await this.buildTaskPrompt()))
  }

  async buildTaskPrompt(): Promise<string> {
    const activeTask = await taskManager.getActiveTask()
    if (!activeTask) {
      return '[正在进行任务]\n无进行中任务'
    }

    const parts: string[] = [`[正在进行任务]`]
    parts.push(`任务ID: ${activeTask.id}`)
    parts.push(`描述: ${activeTask.description}`)
    parts.push(`状态: ${activeTask.status}`)

    if (activeTask.notes?.length) {
      parts.push(`\n[任务笔记]`)
      for (const note of activeTask.notes) {
        parts.push(`- [${note.type}] ${note.content}`)
      }
    }

    if (activeTask.attachedSkills && Object.keys(activeTask.attachedSkills).length > 0) {
      parts.push(`\n[任务关联技能]`)
      for (const [skillName, skillContent] of Object.entries(activeTask.attachedSkills)) {
        parts.push(`\n## ${skillName}\n${skillContent}`)
      }
    }

    return parts.join('\n')
  }
}

export const TASK_CONTEXT = new TaskContextBuilder()
