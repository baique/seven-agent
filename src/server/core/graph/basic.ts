import { END, START, StateGraph } from '@langchain/langgraph'
import { PersistNode } from '../nodes/persist-node'
import { MessagesState } from '../state/llm-state'
import { AbstractAgentWrapper } from './base-wrapper'
import { LLMNode } from '../nodes/llm-node'
import { TaskToolNode } from '../nodes/tool-node'
import { SummaryNode } from '../nodes/summary-node'
import { AIMessage } from '@langchain/core/messages'

export class BasicAgentWrapper extends AbstractAgentWrapper<typeof MessagesState> {
  createAgentBuilder() {
    const graph = new StateGraph(MessagesState)

    return (
      graph
        .addNode('summaryNode', SummaryNode)
        .addNode('llmCall', LLMNode)
        .addNode('taskNode', TaskToolNode)
        .addNode('persistNode', PersistNode)
        .addEdge(START, 'summaryNode')
        .addEdge('summaryNode', 'llmCall')
        // llm直接返回，或者调用工具
        .addConditionalEdges('llmCall', routerTaskOrPersist, ['taskNode', 'persistNode'])
        // 调用工具，并存储结果...
        .addEdge('taskNode', 'persistNode')
        .addConditionalEdges('persistNode', routerLLMOrEND, ['summaryNode', END])
        .addEdge('summaryNode', 'llmCall')
    )
  }
}

export const routerTaskOrPersist = async (state: typeof MessagesState.State): Promise<string> => {
  const lastMessage = state.messages.at(-1) as AIMessage

  if (lastMessage?.tool_calls?.length) {
    return 'taskNode'
  }
  return 'persistNode'
}

export const routerLLMOrEND = (state: typeof MessagesState.State): string => {
  // 取消就结束，不回llm节点
  if (state.cancelled) {
    return END
  }
  if (state.hasToolCalls) {
    return 'summaryNode'
  }
  return END
}
