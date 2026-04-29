import { DynamicStructuredTool } from '@langchain/core/tools'
import { fileSystemTools } from './filesystem'
import { pythonREPLTool } from './python'
import { getSystemInfoTool, getCurrentTimeTool, getClipboardTool, setClipboardTool } from './system'
import { memorySearchTools } from './memory-search'
import { updateMemoryTool } from './memory-update'
import { memoryDeepSearchTools } from './memory-deep-search'
import { skillsTools } from './skills'
import { openWindowTool } from './notification'
import { updateMoodValuesTool } from './mood-tool'
import { taskTools } from './task-tool'
import { terminalTool } from './terminal'
import { reminderTools } from './reminder-tool'
import { subAgentTools } from '../agents/subagent-tool'
import { extManagementTools } from './ext-tools'

export { fileSystemTools, pythonREPLTool }
export { getSystemInfoTool, getCurrentTimeTool, getClipboardTool, setClipboardTool }
export { memorySearchTools, updateMemoryTool, memoryDeepSearchTools }
export { skillsTools }
export { openWindowTool as showNotificationTool }
export { taskTools }
export { terminalTool }
export { reminderTools }
export { subAgentTools }

/**
 * 核心工具 - 主 Agent 常驻上下文
 * 包含最基础、最常用的工具
 */
export const coreTools: DynamicStructuredTool[] = [
  updateMoodValuesTool,
  updateMemoryTool,
  ...taskTools,
  openWindowTool,
  ...reminderTools,
  ...memorySearchTools,
  ...memoryDeepSearchTools,
  ...fileSystemTools,
  terminalTool,
  getSystemInfoTool,
  getCurrentTimeTool,
  getClipboardTool,
  setClipboardTool,
  ...subAgentTools,
  ...extManagementTools,
  pythonREPLTool,
  ...skillsTools,
]

/**
 * 核心工具名称映射表（用于快速查找）
 */
export const baseToolsByName: Record<string, DynamicStructuredTool> = Object.fromEntries(
  coreTools.map((tool) => [tool.name, tool]),
)
