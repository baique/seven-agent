import { readdir, readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../../utils/logger'
import { paths } from '../../config/env'

export interface SkillMetadata {
  name: string
  description: string
  homepage?: string
  metadata?: {
    openclaw?: {
      emoji?: string
      os?: string[]
      requires?: {
        bins?: string[]
        anyBins?: string[]
        env?: string[]
        config?: string[]
      }
      primaryEnv?: string
      skillKey?: string
      install?: Array<{
        id: string
        kind: string
        formula?: string
        package?: string
        bins?: string[]
        label: string
        os?: string[]
      }>
    }
  }
}

export interface Skill extends SkillMetadata {
  content: string
  basePath: string
}

/**
 * 简单的 YAML 解析器，用于解析 frontmatter
 */
function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yamlStr.split('\n')
  let currentIndent = 0
  let inNestedObject = false
  let nestedObject: Record<string, unknown> | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const indent = line.search(/\S|$/)
    const trimmedLine = line.trim()

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) continue

    const key = trimmedLine.slice(0, colonIndex).trim()
    let value = trimmedLine.slice(colonIndex + 1).trim()

    if (indent === 0) {
      inNestedObject = false
      nestedObject = null

      if (value === '' && i + 1 < lines.length) {
        const nextLine = lines[i + 1]
        const nextIndent = nextLine.search(/\S|$/)
        if (nextIndent > 0 && nextLine.trim().includes(':')) {
          result[key] = {}
          nestedObject = result[key] as Record<string, unknown>
          inNestedObject = true
          currentIndent = nextIndent
          continue
        }
      }

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1)
      }

      result[key] = value
    } else if (inNestedObject && nestedObject && indent >= currentIndent) {
      if (value === '' && i + 1 < lines.length) {
        const nextLine = lines[i + 1]
        const nextIndent = nextLine.search(/\S|$/)
        if (nextIndent > indent && nextLine.trim().includes(':')) {
          nestedObject[key] = {}
          const subNested = nestedObject[key] as Record<string, unknown>
          i++
          while (i + 1 < lines.length) {
            const subLine = lines[i + 1]
            const subIndent = subLine.search(/\S|$/)
            if (subIndent <= indent) break
            i++
            const subTrimmed = subLine.trim()
            const subColonIndex = subTrimmed.indexOf(':')
            if (subColonIndex > 0) {
              const subKey = subTrimmed.slice(0, subColonIndex).trim()
              let subValue = subTrimmed.slice(subColonIndex + 1).trim()
              if (subValue.startsWith('"') && subValue.endsWith('"')) {
                subValue = subValue.slice(1, -1)
              }
              subNested[subKey] = subValue
            }
          }
          continue
        }
      }

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1)
      }

      nestedObject[key] = value
    }
  }

  return result
}

function parseSkillMd(content: string): { metadata: SkillMetadata; body: string } | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)

  if (!frontmatterMatch) {
    return null
  }

  try {
    const frontmatter = frontmatterMatch[1]
    const body = frontmatterMatch[2]

    const parsed = parseSimpleYaml(frontmatter)

    const skillMetadata: SkillMetadata = {
      name: parsed.name as string,
      description: parsed.description as string,
      homepage: parsed.homepage as string | undefined,
      metadata: parsed.metadata as SkillMetadata['metadata'],
    }

    return { metadata: skillMetadata, body }
  } catch (error) {
    logger.error(`[Skills] 解析SKILL.md失败: ${error}`)
    return null
  }
}

async function loadSkill(skillDir: string): Promise<Skill | null> {
  const skillMdPath = path.join(skillDir, 'SKILL.md')

  try {
    const content = await readFile(skillMdPath, 'utf-8')
    const parsed = parseSkillMd(content)

    if (!parsed) {
      logger.warn(`[Skills] 无法解析 ${skillMdPath}`)
      return null
    }

    return {
      ...parsed.metadata,
      content: parsed.body,
      basePath: skillDir,
    }
  } catch (error) {
    logger.warn(`[Skills] 读取 ${skillMdPath} 失败: ${error}`)
    return null
  }
}

export async function loadSkills(skillsDir?: string): Promise<Skill[]> {
  const skillsPath = skillsDir
    ? path.isAbsolute(skillsDir)
      ? skillsDir
      : path.resolve(paths.WORKSPACE_ROOT, skillsDir)
    : paths.SKILLS_DIR

  const skills: Skill[] = []

  let entries: string[]
  try {
    entries = await readdir(skillsPath)
  } catch {
    return skills
  }

  for (const entry of entries) {
    const skillDir = path.join(skillsPath, entry)
    try {
      const stats = await stat(skillDir)
      if (stats.isDirectory()) {
        const skill = await loadSkill(skillDir)
        if (skill) {
          skills.push(skill)
        }
      }
    } catch {}
  }

  return skills
}

export function formatSkillsMetadataForPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return '（暂无内置技能）'
  }

  const lines: string[] = []

  for (const skill of skills) {
    lines.push(`- **${skill.name}**：${skill.description}`)
  }

  return lines.join('\n')
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return ''
  }

  const lines: string[] = ['## 可用技能 (Skills)', '']

  for (const skill of skills) {
    lines.push(`### ${skill.name}`)
    lines.push('')
    lines.push(skill.description)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    '当用户请求与某个技能相关的任务时，请先阅读该技能的详细内容，然后按照技能中的指导执行操作。',
  )

  return lines.join('\n')
}

export function formatSkillDetail(skill: Skill): string {
  const lines: string[] = []

  lines.push(`# ${skill.name}`)
  lines.push('')
  lines.push(`**描述**: ${skill.description}`)
  lines.push('')

  if (skill.homepage) {
    lines.push(`**主页**: ${skill.homepage}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(skill.content)

  return lines.join('\n')
}

// 技能缓存
let skillsCache: Skill[] | null = null
let isLoading = false
let isInitialized = false

/**
 * 获取所有技能（带缓存）
 * 优先级：.agents/skills > 工作空间 skills
 * 缓存只在文件变化时通过 clearSkillsCache() 清除，不会自动过期
 */
export async function getSkills(): Promise<Skill[]> {
  // 使用缓存（不在加载中时）
  if (skillsCache && !isLoading) {
    return skillsCache
  }

  // 防止并发加载
  if (isLoading) {
    // 等待正在进行的加载完成
    while (isLoading) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return skillsCache || []
  }

  isLoading = true

  try {
    // 加载工作空间 skills（优先级低）
    const skillsDir = paths.SKILLS_DIR
    const skillsDirSkills = await loadSkills(skillsDir)

    // 加载 .agents/skills 目录（优先级高）
    const agentDir = path.join(homedir(), '.agents', 'skills')
    const agentDirSkills = await loadSkills(agentDir)

    // 合并并去重，优先级高的后添加会覆盖
    const skillMap = new Map<string, Skill>()

    // 先添加工作空间 skills
    for (const skill of skillsDirSkills) {
      skillMap.set(skill.name, skill)
    }

    // 再添加 .agents/skills（优先级最高）
    for (const skill of agentDirSkills) {
      skillMap.set(skill.name, skill)
    }

    const prevSkills = skillsCache
    skillsCache = Array.from(skillMap.values())

    // 只在初始化或真正变化时输出日志
    if (!isInitialized || hasSkillsChanged(prevSkills, skillsCache)) {
      const skillNames = skillsCache.map((s) => s.name).join(', ')
      logger.info(`[Skills] 加载了 ${skillsCache.length} 个技能: ${skillNames}`)
      isInitialized = true
    }

    return skillsCache
  } catch (error) {
    logger.error(`[Skills] 加载技能失败: ${error}`)
    return skillsCache || []
  } finally {
    isLoading = false
  }
}

/**
 * 检查skills列表是否发生变化
 */
function hasSkillsChanged(prev: Skill[] | null, current: Skill[]): boolean {
  if (!prev || prev.length !== current.length) {
    return true
  }

  const prevNames = new Set(prev.map((s) => s.name).sort())
  const currentNames = new Set(current.map((s) => s.name).sort())

  if (prevNames.size !== currentNames.size) {
    return true
  }

  for (const name of prevNames) {
    if (!currentNames.has(name)) {
      return true
    }
  }

  return false
}

/**
 * 清除技能缓存
 * 在技能文件变化时调用
 */
export function clearSkillsCache(): void {
  skillsCache = null
  logger.info('[Skills] 技能缓存已清除')
}

// ==================== 文件监听 ====================

let skillsWatcher: FSWatcher | null = null
let isWatching = false

/**
 * 监听skills目录变化
 */
export function startSkillsWatcher(): void {
  if (isWatching) {
    return
  }

  const skillsDir = paths.SKILLS_DIR

  try {
    skillsWatcher = watch(skillsDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return

      // 只监听SKILL.md文件的变化
      if (filename.endsWith('SKILL.md')) {
        logger.info(`[Skills] 检测到文件变化: ${filename} (${eventType})`)
        clearSkillsCache()
      }
    })

    isWatching = true
    logger.info(`[Skills] 开始监听目录: ${skillsDir}`)

    // 监听错误
    skillsWatcher.on('error', (error) => {
      logger.error(`[Skills] 监听出错: ${error}`)
    })
  } catch (error) {
    logger.error(`[Skills] 启动监听失败: ${error}`)
  }
}

/**
 * 停止监听skills目录
 */
export function stopSkillsWatcher(): void {
  if (skillsWatcher) {
    skillsWatcher.close()
    skillsWatcher = null
    isWatching = false
    logger.info('[Skills] 已停止监听')
  }
}
