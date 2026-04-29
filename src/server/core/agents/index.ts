/**
 * SubAgent模块
 * 提供子代理的加载和执行功能
 */

export {
  getAgents,
  getAgentByName,
  clearAgentsCache,
  loadAgents,
  startAgentsWatcher,
  stopAgentsWatcher,
} from './agents-loader'
export { subAgentTools, subagentTool, listSubAgentsTool } from './subagent-tool'
export type { Agent, AgentMetadata } from './agents-loader'
