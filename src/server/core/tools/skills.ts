import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { getSkills, formatSkillDetail } from './skills-loader'
import path from 'node:path'
import { ToolResult } from '../../utils/tool-response'

const readSkillSchema = z.object({
  name: z.string().describe('技能名称'),
})

export const readSkillTool = new DynamicStructuredTool({
  name: 'read_skill',
  description: '读取指定技能的完整内容。当需要了解技能的具体使用方法、步骤和指导时使用。',
  schema: readSkillSchema,
  func: async ({ name }) => {
    const toolName = 'read_skill'
    const skills = await getSkills()
    const skill = skills.find(
      (s) => s.name.toLowerCase() === name.toLowerCase() || s.name.includes(name),
    )

    if (!skill) {
      const availableNames = skills.map((s) => s.name).join(', ')
      return await ToolResult.error(toolName, {
        msg: `未找到名为 "${name}" 的技能`,
        body: `可用技能: ${availableNames}`,
        extra: { requestedName: name },
      })
    }

    const detail = formatSkillDetail(skill)
    return await ToolResult.success(toolName, {
      msg: `技能 "${skill.name}" 读取成功`,
      body: detail,
      extra: {
        skillName: skill.name,
        skillDescription: skill.description,
      },
    })
  },
})

const createSkillSchema = z.object({
  name: z.string().describe('技能名称，仅小写字母、数字、连字符'),
  description: z.string().describe('技能描述，说明何时使用此技能'),
  content: z.string().describe('技能内容，包含具体的使用指导和步骤'),
})

export const createSkillTool = new DynamicStructuredTool({
  name: 'create_skill',
  description: '创建新的技能文件。技能是可复用的指令集，用于指导如何完成特定类型的任务。',
  schema: createSkillSchema,
  func: async ({ name, description, content }) => {
    const toolName = 'create_skill'
    const { paths } = await import('../../config/env')
    const { writeFile, mkdir } = await import('node:fs/promises')

    const skillDir = path.join(paths.SKILLS_DIR, name)
    const skillMdPath = path.join(skillDir, 'SKILL.md')

    const frontmatter = `---
name: ${name}
description: ${description}
---

${content}`

    try {
      await mkdir(skillDir, { recursive: true })
      await writeFile(skillMdPath, frontmatter, 'utf-8')

      return await ToolResult.success(toolName, {
        msg: `技能 "${name}" 已创建成功`,
        body: `位置: ${skillDir}`,
        extra: { skillName: name, skillPath: skillDir },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return await ToolResult.error(toolName, {
        msg: '创建技能失败',
        body: errorMsg,
        extra: { skillName: name },
      })
    }
  },
})

export const skillsTools = [readSkillTool, createSkillTool]
