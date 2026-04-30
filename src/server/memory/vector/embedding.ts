/**
 * EmbeddingProvider - 嵌入向量提供者
 * 支持本地模型（优先）和 OpenAI 协议兼容的远程 API
 * 设计原则：优先本地，自动降级，可配置
 */

import type { EmbeddingProvider } from './types'

/**
 * 本地嵌入提供者配置
 */
export interface LocalEmbeddingConfig {
  /** 模型路径（空则使用默认） */
  modelPath?: string
  /** 上下文大小 */
  contextSize?: number
  /** 向量维度 */
  dimensions?: number
}

/**
 * 远程嵌入提供者配置
 */
export interface RemoteEmbeddingConfig {
  /** API 密钥 */
  apiKey: string
  /** API 基础 URL（空则使用 OpenAI 官方） */
  baseUrl?: string
  /** 模型名称 */
  model?: string
  /** 向量维度 */
  dimensions?: number
}

/**
 * 嵌入提供者管理器配置
 */
export interface EmbeddingManagerConfig {
  /** 本地模型配置 */
  local?: LocalEmbeddingConfig
  /** 远程 API 配置 */
  remote?: RemoteEmbeddingConfig
  /** 是否优先使用本地模型（默认true） */
  preferLocal?: boolean
}

/**
 * 本地嵌入提供者（基于 llama.cpp）
 * 注意：这是一个占位实现，实际需要使用 node-llama-cpp 或其他本地推理库
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  id = 'local'
  model: string
  dimensions: number
  private config: LocalEmbeddingConfig
  private initialized = false

  constructor(config: LocalEmbeddingConfig = {}) {
    this.config = config
    this.model = config.modelPath || 'nomic-embed-text-v1.5'
    this.dimensions = config.dimensions || 768
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // TODO: 实际实现需要使用 node-llama-cpp 或其他本地推理库
    // 这里提供一个模拟实现用于测试
    console.log(`[LocalEmbeddingProvider] 初始化本地模型: ${this.model}`)
    
    // 模拟加载延迟
    await new Promise(resolve => setTimeout(resolve, 100))
    
    this.initialized = true
  }

  async embed(text: string): Promise<number[]> {
    if (!this.initialized) await this.initialize()

    // TODO: 实际实现需要调用本地模型
    // 这里提供一个基于哈希的模拟实现，确保相同文本产生相同向量
    return this.simulateEmbedding(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized) await this.initialize()

    // 串行处理，实际实现可以并行
    const results: number[][] = []
    for (const text of texts) {
      results.push(await this.embed(text))
    }
    return results
  }

  /**
   * 模拟嵌入生成（基于文本哈希）
   * 用于测试阶段，确保相同文本产生相同向量
   */
  private simulateEmbedding(text: string): number[] {
    // 使用简单的哈希算法生成伪随机但确定的向量
    const vector: number[] = []
    let seed = this.hashString(text)
    
    for (let i = 0; i < this.dimensions; i++) {
      // 使用线性同余生成器产生伪随机数
      seed = (seed * 1664525 + 1013904223) % 4294967296
      const value = (seed / 4294967296) * 2 - 1  // 归一化到 [-1, 1]
      vector.push(value)
    }
    
    // L2 归一化
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
    return vector.map(v => v / norm)
  }

  private hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // 转换为32位整数
    }
    return Math.abs(hash)
  }
}

/**
 * OpenAI 协议兼容的远程嵌入提供者
 */
class OpenAICompatibleProvider implements EmbeddingProvider {
  id = 'openai-compatible'
  model: string
  dimensions: number
  private config: RemoteEmbeddingConfig
  private baseUrl: string

  constructor(config: RemoteEmbeddingConfig) {
    this.config = config
    this.model = config.model || 'text-embedding-3-small'
    this.dimensions = config.dimensions || 1536
    this.baseUrl = config.baseUrl?.replace(/\/$/, '') || 'https://api.openai.com/v1'
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
        dimensions: this.dimensions,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Embedding API error: ${response.status} ${error}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return data.data[0].embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        dimensions: this.dimensions,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Embedding API error: ${response.status} ${error}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map((d) => d.embedding)
  }
}

/**
 * 嵌入提供者管理器
 * 管理本地和远程提供者，优先使用本地模型
 */
export class EmbeddingProviderManager {
  private provider: EmbeddingProvider | null = null
  private config: EmbeddingManagerConfig
  private initialized = false

  constructor(config: EmbeddingManagerConfig = {}) {
    this.config = {
      preferLocal: true,
      ...config,
    }
  }

  /**
   * 初始化嵌入提供者
   * 优先尝试本地模型，失败则回退到远程 API
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // 优先尝试本地模型
    if (this.config.preferLocal !== false) {
      try {
        const localProvider = new LocalEmbeddingProvider(this.config.local)
        await localProvider.initialize()
        this.provider = localProvider
        console.log('[EmbeddingProviderManager] 使用本地嵌入模型')
        this.initialized = true
        return
      } catch (err) {
        console.warn(`[EmbeddingProviderManager] 本地模型加载失败: ${err}`)
      }
    }

    // 回退到远程 API
    if (this.config.remote?.apiKey) {
      try {
        this.provider = new OpenAICompatibleProvider(this.config.remote)
        console.log('[EmbeddingProviderManager] 使用远程嵌入 API')
        this.initialized = true
        return
      } catch (err) {
        console.error(`[EmbeddingProviderManager] 远程 API 初始化失败: ${err}`)
      }
    }

    throw new Error('没有可用的嵌入提供者（本地模型加载失败且未配置远程 API）')
  }

  /**
   * 生成单条文本的嵌入向量
   */
  async embed(text: string): Promise<number[]> {
    if (!this.initialized) await this.initialize()
    if (!this.provider) throw new Error('嵌入提供者未初始化')
    return this.provider.embed(text)
  }

  /**
   * 批量生成嵌入向量
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized) await this.initialize()
    if (!this.provider) throw new Error('嵌入提供者未初始化')
    return this.provider.embedBatch(texts)
  }

  /**
   * 获取当前提供者信息
   */
  getProviderInfo(): { id: string; model: string; dimensions: number } | null {
    if (!this.provider) return null
    return {
      id: this.provider.id,
      model: this.provider.model,
      dimensions: this.provider.dimensions,
    }
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

// 默认导出：创建默认配置的提供者管理器
export function createEmbeddingProvider(config?: EmbeddingManagerConfig): EmbeddingProviderManager {
  return new EmbeddingProviderManager(config)
}
