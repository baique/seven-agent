import { BaseMessage } from 'langchain'
import { ContextBuilder } from '../context-builder'
import {
  getSkills,
  formatSkillsForPrompt,
  Skill,
  clearSkillsCache,
} from '../../../tools/skills-loader'
import { paths } from '../../../../config/env'
import { logger } from '../../../../utils/logger'
import { watch, FSWatcher, existsSync } from 'fs'
import path from 'path'
import { homedir } from 'os'

/**
 * 技能上下文构建器
 * 负责加载技能信息到上下文，并监听技能目录变化自动刷新
 */
export class SkillBuilder implements ContextBuilder {
  private skills: Skill[] = []
  private watchers: FSWatcher[] = []
  private skillsDir: string
  private agentDir: string

  constructor() {
    this.skillsDir = paths.SKILLS_DIR
    // .agents/skills 目录在用户主目录下
    this.agentDir = path.join(homedir(), '.agents', 'skills')
  }

  /**
   * 初始化技能构建器
   * 加载技能并设置目录监听
   */
  async init(): Promise<void> {
    await this.loadSkills()
    this.setupWatchers()
  }

  /**
   * 将技能信息挂载到上下文
   */
  async mountToContext(messages: BaseMessage[]): Promise<void> {
    if (this.skills.length === 0) {
      logger.info(`[SkillBuilder] 没有技能可挂载到上下文`)
      return
    }
    const skillsPrompt = formatSkillsForPrompt(this.skills)
    // logger.info(`[SkillBuilder] 挂载技能到上下文: ${skillsPrompt}`)
    messages[0].content += `[可用技能]\n${skillsPrompt}`
  }

  /**
   * 持久化（技能信息不需要持久化）
   */
  persist(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * 加载技能
   * 使用 getSkills() 获取统一加载的技能列表
   */
  private async loadSkills(): Promise<void> {
    try {
      this.skills = await getSkills()
      // 日志已在 getSkills() 中输出，这里不再重复
    } catch (error) {
      logger.error(`[SkillBuilder] 加载技能失败: ${error}`)
      this.skills = []
    }
  }

  /**
   * 重新加载技能
   */
  private async reloadSkills(triggerInfo: {
    label: string
    filename: string
    eventType: string
  }): Promise<void> {
    logger.info(`[SkillBuilder] 重新加载技能: ${triggerInfo.filename}`)
    clearSkillsCache()
    await this.loadSkills()
  }

  /**
   * 设置目录监听
   */
  private setupWatchers(): void {
    // 批量监听多个目录
    const dirs = [
      { path: this.skillsDir, label: '工作空间 skills' },
      { path: this.agentDir, label: '.agents/skills' },
    ]
    this.watchDirectories(dirs)
  }

  /**
   * 批量监听多个目录
   */
  private watchDirectories(dirs: Array<{ path: string; label: string }>): void {
    for (const { path, label } of dirs) {
      if (!existsSync(path)) {
        continue
      }
      try {
        const watcher = watch(path, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.md')) {
            this.debouncedReload(label, filename, eventType)
          }
        })
        this.watchers.push(watcher)
      } catch (error) {
        logger.warn(`[SkillBuilder] 监听失败: ${path}`)
      }
    }
    // 统一输出一条日志
    const validDirs = dirs.filter((d) => existsSync(d.path))
    if (validDirs.length > 0) {
      logger.info(`[SkillBuilder] 监听技能目录: ${validDirs.map((d) => d.label).join(', ')}`)
    }
  }

  private reloadTimer: NodeJS.Timeout | null = null
  private readonly RELOAD_DEBOUNCE_MS = 3000
  private lastTriggerInfo: { label: string; filename: string; eventType: string } | null = null

  /**
   * 防抖重新加载技能
   */
  private debouncedReload(label: string, filename: string, eventType: string): void {
    this.lastTriggerInfo = { label, filename, eventType }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
    }
    this.reloadTimer = setTimeout(() => {
      if (this.lastTriggerInfo) {
        this.reloadSkills(this.lastTriggerInfo)
        this.lastTriggerInfo = null
      }
      this.reloadTimer = null
    }, this.RELOAD_DEBOUNCE_MS)
  }

  /**
   * 关闭监听
   */
  destroy(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    for (const watcher of this.watchers) {
      watcher.close()
    }
    this.watchers = []
  }
}

export const SKILL_CONTEXT = new SkillBuilder()
