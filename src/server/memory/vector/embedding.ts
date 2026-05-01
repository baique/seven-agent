/**
 * EmbeddingProvider - 嵌入向量提供者
 * 支持本地模型（优先）和 OpenAI 协议兼容的远程 API
 * 设计原则：优先本地，自动降级，可配置
 */

import { pipeline, env as transformersEnv } from '@xenova/transformers'
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import type { EmbeddingProvider } from './types'
import { logger } from '../../utils/logger'

transformersEnv.allowLocalModels = true
transformersEnv.useBrowserCache = false
transformersEnv.remoteHost = 'https://huggingface.co'
console.log(`[EmbeddingProvider] remoteHost: ${transformersEnv.remoteHost}`)

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
  console.log(`[EmbeddingProvider] 已启用全局代理: ${proxyUrl}`)
} else {
  console.log('[EmbeddingProvider] 未配置代理，使用直连')
}

const modelDownloadLogger = (progress: {
  status: string
  progress?: number
  file?: string
  msg?: string
}) => {
  switch (progress.status) {
    case 'initiate':
      console.log(`[Embedding下载] 开始下载: ${progress.file}`)
      break
    case 'progress':
      if (progress.progress !== undefined) {
        const bar =
          '█'.repeat(Math.floor(progress.progress / 5)) +
          '░'.repeat(20 - Math.floor(progress.progress / 5))
        process.stdout.write(
          `\r[Embedding下载] ${progress.file} ${bar} ${progress.progress.toFixed(1)}%`,
        )
      }
      break
    case 'done':
      process.stdout.write('\n')
      console.log(`[Embedding下载] 完成: ${progress.file}`)
      break
    case 'error':
      process.stdout.write('\n')
      console.error(`[Embedding下载] 错误: ${progress.file} - ${progress.msg}`)
      break
  }
}

/**
 * 本地嵌入提供者配置
 */
export interface LocalEmbeddingConfig {
  /** 模型名称（HuggingFace repo id） */
  modelName?: string
  /** 模型本地路径（优先使用） */
  modelPath?: string
  /** 上下文大小 */
  contextSize?: number
  /** 向量维度（默认768） */
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
 * 本地嵌入提供者（基于 @xenova/transformers）
 * 使用 HuggingFace 模型生成嵌入向量
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  id = 'local'
  model: string
  dimensions: number
  private config: LocalEmbeddingConfig
  private initialized = false
  private embedder: Awaited<ReturnType<typeof pipeline<'feature-extraction'>>> | null = null

  constructor(config: LocalEmbeddingConfig = {}) {
    this.config = config
    this.model = config.modelName || 'Xenova/bge-small-zh-v1.5'
    this.dimensions = config.dimensions || 512
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const cacheDir = this.config.modelPath || undefined
    const isLocal = !!cacheDir

    if (isLocal) {
      console.log(`[LocalEmbeddingProvider] 使用本地模型: ${this.model}, 路径: ${cacheDir}`)
    } else {
      console.log(`[LocalEmbeddingProvider] 首次使用，从 HuggingFace 下载模型: ${this.model}`)
      console.log(`[LocalEmbeddingProvider] 缓存目录: ${cacheDir || '默认缓存目录'}`)
      console.log(`[LocalEmbeddingProvider] 预计大小 ~1.5GB，请耐心等待...\n`)
    }

    try {
      this.embedder = await pipeline('feature-extraction', this.model, {
        cache_dir: cacheDir,
        progress_callback: modelDownloadLogger,
      })
      this.initialized = true
      console.log(`[LocalEmbeddingProvider] 模型加载完成，维度: ${this.dimensions}`)
    } catch (err) {
      logger.error(err, `[LocalEmbeddingProvider] 模型加载失败: `)
      throw err
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.initialized || !this.embedder) await this.initialize()

    const result = await this.embedder!(text, { pooling: 'mean', normalize: true })
    return Array.from(result.data as Float32Array)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized || !this.embedder) await this.initialize()

    const results: number[][] = []
    for (const text of texts) {
      const result = await this.embedder!(text, { pooling: 'mean', normalize: true })
      results.push(Array.from(result.data as Float32Array))
    }
    return results
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
        Authorization: `Bearer ${this.config.apiKey}`,
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
        Authorization: `Bearer ${this.config.apiKey}`,
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
