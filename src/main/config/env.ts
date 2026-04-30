/**
 * 环境配置模块 (UI层专用)
 * 只包含UI层需要的配置：Live2D模型、Socket端口
 */
import { config } from 'dotenv'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'

/**
 * 获取资源根目录
 * 开发环境: 返回项目根目录
 * 打包后: 返回 app.asar 所在目录 (process.resourcesPath)
 */
const getResRoot = (): string => {
  try {
    const isPackaged = app?.isPackaged ?? false
    if (isPackaged) {
      return process.resourcesPath
    }
    return app?.getAppPath?.() ?? process.env.RES_ROOT ?? path.resolve()
  } catch {
    return process.env.RES_ROOT || path.resolve()
  }
}

/** 资源根目录路径 */
const RES_ROOT = getResRoot()

/**
 * 环境变量校验模式
 * UI层只需要Live2D相关配置和Socket端口
 */
const envSchema = z.object({
  /** Live2D 模型 URL */
  LIVE2D_MODEL_URL: z.string(),
  /** Live2D 模型空闲行为配置路径 */
  LIVE2D_IDLE_BEHAVIORS_PATH: z.string().optional(),
  /** Live2D 模型默认参数配置路径 */
  LIVE2D_DEFAULT_PARAMS_PATH: z.string().optional(),
  /** Socket 服务器端口 */
  SOCKET_PORT: z.coerce.number().default(9172),
})

/**
 * 加载环境变量
 */
const loadEnv = () => {
  const envFileName = process.env.ENV_FILE || '.env'
  const isPackaged = app?.isPackaged ?? false
  const envPath = isPackaged
    ? path.join(process.resourcesPath, envFileName)
    : path.join(RES_ROOT, envFileName)
  try {
    config({ path: envPath, override: false })
  } catch (e) {
    console.warn(`Failed to load .env from ${envPath}, trying process.cwd()`)
    config({ path: path.join(process.cwd(), '.env'), override: false })
  }
}

loadEnv()

/** 解析后的环境变量 */
export const env = envSchema.parse(process.env)

/**
 * 获取 Live2D 模型 URL
 * 如果配置的是 http/https 地址，直接使用
 * 否则使用本地 HTTP 协议通过 server 的静态文件服务访问
 * URL 格式: http://localhost:{SOCKET_PORT}/live2d/{modelPath}
 */
export const getLive2DModelUrl = (): string => {
  const modelPath = env.LIVE2D_MODEL_URL

  // 如果已经是 http/https 地址，直接使用
  if (modelPath.startsWith('http://') || modelPath.startsWith('https://')) {
    return modelPath
  }

  // 移除路径开头的 live2d/ 或 model/
  const cleanPath = modelPath.replace(/^(live2d|model)\//, '')

  return `http://localhost:${env.SOCKET_PORT}/live2d/${cleanPath}`
}

/**
 * 模型参数配置接口
 */
export interface ModelParam {
  /** 参数ID */
  id: string
  /** 参数值 */
  value: number
}

/**
 * 完整模型配置接口
 */
export interface Live2DModelConfig {
  /** 模型URL */
  modelUrl: string
  /** idle-behaviors.json 路径 */
  idleBehaviorsPath: string | null
  /** 默认参数文件路径 */
  defaultParamsPath: string | null
  /** 默认参数数组 */
  defaultParams: ModelParam[]
}

/**
 * 解析 Live2D 资源路径
 * 从工作空间的 live2d 目录读取
 */
const resolveLive2DResourcePath = (relativePath: string | undefined): string | null => {
  if (!relativePath) return null
  if (path.isAbsolute(relativePath)) return relativePath

  // 从工作空间的 live2d 目录读取
  const workspacePath = process.env.WORKSPACE || process.cwd()
  // 移除路径开头的 live2d/ 或 model/，因为工作空间路径已经包含 live2d/
  const cleanPath = relativePath.replace(/^(live2d|model)\//, '')
  return path.join(workspacePath, 'live2d', cleanPath)
}

/**
 * 获取 Live2D 模型完整配置
 */
export const getLive2DModelConfig = (): Live2DModelConfig => {
  const modelUrl = getLive2DModelUrl()
  const idleBehaviorsPath = env.LIVE2D_IDLE_BEHAVIORS_PATH
  const defaultParamsPath = env.LIVE2D_DEFAULT_PARAMS_PATH

  let defaultParams: ModelParam[] = []
  const resolvedDefaultParamsPath = resolveLive2DResourcePath(defaultParamsPath)
  if (resolvedDefaultParamsPath && fs.existsSync(resolvedDefaultParamsPath)) {
    try {
      const content = fs.readFileSync(resolvedDefaultParamsPath, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        defaultParams = parsed as ModelParam[]
      }
    } catch (e) {
      console.warn('[ModelConfig] 读取 default.param.json 失败:', e)
    }
  }

  return {
    modelUrl,
    idleBehaviorsPath: idleBehaviorsPath ?? null,
    defaultParamsPath: defaultParamsPath ?? null,
    defaultParams,
  }
}
