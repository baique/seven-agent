import type { StateGraph } from '@langchain/langgraph'

export abstract class AbstractAgentWrapper<T> {
  public abstract createAgentBuilder(): StateGraph<T, any, any, any>

  public createAgent(agentParam: any): ReturnType<StateGraph<T, any, any, any>['compile']> {
    return this.createAgentBuilder().compile({
      ...agentParam,
    })
  }
}
