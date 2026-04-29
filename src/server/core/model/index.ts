import { ChatOpenAI } from '@langchain/openai'
import { env } from '../../config/env'
import { logger } from '../../utils/logger'
import {
  initModelConfigManager,
  getModelConfigManager,
  type ModelConfig,
} from '../../config/model-config'

interface ExtendedClientOptions {
  baseURL?: string | null | undefined

  httpAgent?: any
}

function getProxyAgent() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy

  if (proxyUrl) {
    logger.info(`[Proxy] 使用代理: ${proxyUrl}`)

    const { HttpsProxyAgent } = require('https-proxy-agent')
    return new HttpsProxyAgent(proxyUrl)
  }

  return undefined
}

let proxyAgent: ReturnType<typeof getProxyAgent> | null = null

function getOrCreateProxyAgent() {
  if (proxyAgent === null) {
    proxyAgent = getProxyAgent()
  }
  return proxyAgent
}

function createChatOpenAI(
  config: ModelConfig,
  args?: Partial<ConstructorParameters<typeof ChatOpenAI>[0]>,
): ChatOpenAI {
  const agent = getOrCreateProxyAgent()

  const baseConfiguration: ExtendedClientOptions = {
    baseURL: config.baseURL as string | null | undefined,
    httpAgent: agent,
  }

  // 显式提取可能覆盖默认值的参数，确保类型正确
  const {
    modelKwargs: userModelKwargs,
    temperature: userTemperature,
    maxTokens: userMaxTokens,
    ...restArgs
  } = args || {}

  // 合并 modelKwargs，确保 thinking 配置正确
  const mergedModelKwargs = {
    thinking: { type: 'disabled' },
    ...userModelKwargs,
  }

  const finalArgs = {
    modelName: config.name as string,
    apiKey: config.apiKey as string,

    configuration: baseConfiguration as any,
    temperature: userTemperature ?? 0,
    maxTokens: userMaxTokens,
    timeout: undefined,
    maxRetries: 2,
    modelKwargs: mergedModelKwargs,
    ...restArgs,
  }
  logger.info(`[Model] 创建模型 ${config.name} 实例，配置: \n${JSON.stringify(finalArgs)}`)
  return new ChatOpenAI(finalArgs)
}

export const DefaultParam = {
  temperature: 0.3,
  topP: 0.9,
  presencePenalty: 1,
  maxConcurrency: 5,
  frequencyPenalty: 1.2,
  maxRetries: 5,
}

// 模型缓存版本
let cacheVersion = 0

// 模型缓存
const modelCache = {
  primary: null as ChatOpenAI | null,
  primaryVersion: -1,
  quiet: null as ChatOpenAI | null,
  quietVersion: -1,
  tool: null as ChatOpenAI | null,
  toolVersion: -1,
  summarization: null as ChatOpenAI | null,
  summarizationVersion: -1,
}

// 初始化
const primaryModelName = env.OPENAI_API_MODEL || ''
const fallbackNames =
  env.OPENAI_API_MODEL_FALLBACKS?.split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0) || []

const modelConfigManager = initModelConfigManager(primaryModelName, fallbackNames)

// 监听配置变化
modelConfigManager.on('configUpdate', () => {
  logger.info('[Model] 配置变更，清空模型缓存')
  cacheVersion++
})

modelConfigManager.on('modelConfigChange', (modelName: string) => {
  const primaryName = modelConfigManager.getPrimaryName()
  const fallbackNamesList = modelConfigManager.getFallbackNames()

  if (modelName === primaryName || fallbackNamesList.includes(modelName)) {
    logger.info(`[Model] 模型 ${modelName} 配置变化，清空缓存`)
    cacheVersion++
  }
})

// 创建带 fallback 的模型包装器
function createModelWithFallbacks(
  args: Partial<ConstructorParameters<typeof ChatOpenAI>[0]>,
): ChatOpenAI {
  const mc = getModelConfigManager()
  if (!mc) {
    throw new Error('[Model] 模型配置管理器未初始化')
  }

  const primaryConfig = mc.getPrimary()
  if (!primaryConfig) {
    throw new Error(`[Model] 主模型配置不存在: ${mc.getPrimaryName()}`)
  }

  const fallbackConfigs = mc.getFallbacks()
  const primaryModel = createChatOpenAI(primaryConfig, args)

  if (fallbackConfigs.length === 0) {
    logger.info(`[Model] 使用主模型: ${primaryConfig.name}`)
    return primaryModel
  }

  const fallbackModels = fallbackConfigs.map((config) => createChatOpenAI(config, args))

  // 创建包装器，拦截 bindTools 方法
  const wrapper = Object.create(Object.getPrototypeOf(primaryModel))
  Object.assign(wrapper, primaryModel)

  // 重写 bindTools：调用主模型的 bindTools，然后加上 fallback
  if (typeof (primaryModel as any).bindTools === 'function') {
    ;(wrapper as any).bindTools = function (...bindArgs: any[]) {
      const bound = (primaryModel as any).bindTools(...bindArgs)
      return bound.withFallbacks({ fallbacks: fallbackModels })
    }
  }

  // 重写 bind：调用主模型的 bind，然后加上 fallback
  if (typeof (primaryModel as any).bind === 'function') {
    ;(wrapper as any).bind = function (...bindArgs: any[]) {
      const bound = (primaryModel as any).bind(...bindArgs)
      return bound.withFallbacks({ fallbacks: fallbackModels })
    }
  }

  logger.info(
    `[Model] 主模型: ${primaryConfig.name}, Fallback: ${fallbackConfigs.map((c) => c.name).join(', ')}`,
  )

  return wrapper as ChatOpenAI
}

// 获取模型实例（带版本检查）
function getPrimaryModel(): ChatOpenAI {
  if (!modelCache.primary || modelCache.primaryVersion !== cacheVersion) {
    modelCache.primary = createModelWithFallbacks({ ...DefaultParam })
    modelCache.primaryVersion = cacheVersion
  }
  return modelCache.primary
}

function getToolModel(): ChatOpenAI {
  if (!modelCache.tool || modelCache.toolVersion !== cacheVersion) {
    const config = modelConfigManager.getPrimary()
    if (!config) {
      throw new Error('[Model] 主模型配置不存在')
    }
    modelCache.tool = createChatOpenAI(config, {
      tags: ['tool'],
      temperature: 0,
      topP: 0.9,
      maxRetries: 5,
    })
    modelCache.toolVersion = cacheVersion
  }
  return modelCache.tool
}

function getSummarizationModel(): ChatOpenAI {
  if (!modelCache.summarization || modelCache.summarizationVersion !== cacheVersion) {
    const summaryModelName = env.SUMMARIZATION_API_MODEL
    if (summaryModelName) {
      // 尝试加载指定的摘要模型配置
      const config = modelConfigManager.getByName(summaryModelName)
      if (config) {
        logger.info(`[Model] 加载摘要模型: ${summaryModelName}`)
        modelCache.summarization = createChatOpenAI(config, {
          temperature: 0.3,
          streaming: false,
          modelKwargs: { thinking: { type: 'disabled' } },
        })
      } else {
        logger.warn(`[Model] 摘要模型配置不存在: ${summaryModelName}，尝试使用主模型`)
        // 回退到主模型
        const primaryConfig = modelConfigManager.getPrimary()
        if (primaryConfig) {
          logger.warn(`[Model] 摘要模型回退到主模型: ${modelConfigManager.getPrimaryName()}`)
          modelCache.summarization = createChatOpenAI(primaryConfig, {
            temperature: 0,
            streaming: false,
            modelKwargs: { thinking: { type: 'disabled' } },
          })
        }
      }
    } else {
      logger.warn(`[Model] SUMMARIZATION_API_MODEL 未配置，使用主模型作为摘要模型`)
      // 使用主模型作为回退
      const primaryConfig = modelConfigManager.getPrimary()
      if (primaryConfig) {
        modelCache.summarization = createChatOpenAI(primaryConfig, {
          temperature: 0,
          streaming: false,
          modelKwargs: { thinking: { type: 'disabled' } },
        })
      }
    }
    modelCache.summarizationVersion = cacheVersion
  }

  if (!modelCache.summarization) {
    throw new Error('[Model] 摘要模型未正确配置')
  }

  return modelCache.summarization
}

// 创建 Proxy 实现热重载
function createModelProxy(getter: () => ChatOpenAI): ChatOpenAI {
  return new Proxy({} as ChatOpenAI, {
    get(_target, prop) {
      const model = getter()
      const value = (model as any)[prop]
      if (typeof value === 'function') {
        return value.bind(model)
      }
      return value
    },
  })
}

// 导出模型（使用 Proxy 支持热重载）
export const StreamPrimaryPersonModel: ChatOpenAI = createModelProxy(getPrimaryModel)
export const ToolModel: ChatOpenAI = createModelProxy(getToolModel)
export const SummarizationModel: ChatOpenAI = createModelProxy(getSummarizationModel)

// 兼容旧配置的 CreateModel
export const CreateModel = (args: Partial<ConstructorParameters<typeof ChatOpenAI>[0]>) => {
  if (env.OPENAI_API_KEY && env.OPENAI_API_BASE_URL && env.OPENAI_API_MODEL_NAME) {
    const agent = getOrCreateProxyAgent()

    const baseConfiguration: ExtendedClientOptions = {
      baseURL: env.OPENAI_API_BASE_URL,
      httpAgent: agent,
    }

    const userConfiguration = (args as { configuration?: ExtendedClientOptions }).configuration
    const mergedConfiguration = {
      ...baseConfiguration,
      ...userConfiguration,
      httpAgent: agent,
    }

    // 显式提取所有可能覆盖默认值的参数，确保类型正确
    const {
      configuration: _,
      modelKwargs: userModelKwargs,
      temperature: userTemperature,
      maxTokens: userMaxTokens,
      ...restArgs
    } = args as {
      configuration?: unknown
      modelKwargs?: Record<string, unknown>
      temperature?: number
      maxTokens?: number
    }

    // 合并 modelKwargs，确保 thinking 配置正确
    const mergedModelKwargs = {
      thinking: { type: 'disabled' },
      ...userModelKwargs,
    }

    return new ChatOpenAI({
      modelName: env.OPENAI_API_MODEL_NAME,
      apiKey: env.OPENAI_API_KEY,
      configuration: mergedConfiguration as any,
      temperature: userTemperature ?? 0,
      timeout: undefined,
      maxRetries: 2,
      modelKwargs: mergedModelKwargs,
      ...restArgs,
    })
  }

  const mc = getModelConfigManager()
  if (!mc) {
    throw new Error('[Model] 模型配置管理器未初始化')
  }
  const config = mc.getPrimary()
  if (!config) {
    throw new Error('[Model] 主模型配置不存在')
  }
  return createChatOpenAI(config, args)
}
