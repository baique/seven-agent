/**
 * 摘要相关类型定义
 */

/** 记忆操作 - 用于update_memory工具 */
export interface RememberOperation {
  /** 操作类型 */
  action: 'add' | 'remove' | 'update'
  /** 记忆ID（remove/update时需要） */
  id?: string
  /** 记忆内容（add/update时需要） */
  content?: string
  /** 重要性（add/update时需要） */
  importance?: number
}

/** 任务技能绑定 - 用于将技能挂载到任务 */
export interface TaskSkillBinding {
  taskId: string
  skills: string[]
}

/** 场景边界 - LLM提名的对话场景切换点 */
export interface SceneBoundary {
  /** 是否存在场景切换 */
  hasTransition: boolean
  /** 切换点消息ID（LLM提名） */
  transitionId: string
  /** LLM给出的切换原因 */
  reason: string
}

/** 会话笔记 */
export interface SessionNotes {
  /** 摘要内容 */
  notes: string
  /** 记忆操作（内部使用，不挂载到上下文） */
  remember: RememberOperation[]
  /** 任务技能绑定（内部使用，不挂载到上下文） */
  taskSkillBindings: TaskSkillBinding[]
  /** 场景边界（LLM提名，规则否决） */
  sceneBoundary?: SceneBoundary
}
