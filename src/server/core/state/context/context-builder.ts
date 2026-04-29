import { BaseMessage } from 'langchain'

export interface ContextBuilder {
  /**
   * 初始化自身
   */
  init(): Promise<void>
  /**
   * 挂载到上下文
   */
  mountToContext(message: BaseMessage[]): Promise<void>

  /**
   * 持久化
   */
  persist(): Promise<void>
}

export interface CacheContextBuilder extends ContextBuilder {
  /**
   * 是否启用缓存
   */
  cache(): boolean
}
