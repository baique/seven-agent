/**
 * 环境配置模块 (Server层专用)
 * 只包含Server层需要的配置：模型、TTS、向量、阈值等
 *
 * 配置优先级：命令行参数 > 环境变量 > .env 配置文件
 * 命令行参数格式：--KEY=VALUE
 */
import { config } from 'dotenv'
import path from 'node:path'
import { z } from 'zod'

/**
 * 解析命令行参数
 * 支持 --KEY=VALUE 格式，优先级最高
 */
const parseCommandLineArgs = (): Record<string, string> => {
  const args: Record<string, string> = {}
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=')
      if (key && valueParts.length > 0) {
        args[key] = valueParts.join('=')
      }
    }
  }
  return args
}

/** 命令行参数（最高优先级） */
const CLI_ARGS = parseCommandLineArgs()

/**
 * 检查是否在打包后的生产环境
 * 在子进程中无法访问 electron app，使用环境变量判断
 */
const isPackagedEnv = (): boolean => {
  // 优先使用环境变量
  if (process.env.NODE_ENV === 'production') return true
  if (process.env.ELECTRON_IS_PACKAGED === 'true') return true

  // 尝试访问 electron app（仅在主进程中有效）
  try {
    const { app } = require('electron')
    return app?.isPackaged ?? false
  } catch {
    // 子进程中无法加载 electron，默认为开发模式
    return false
  }
}

/**
 * 获取资源根目录
 */
const getResRoot = (): string => {
  try {
    const isPackaged = isPackagedEnv()
    if (isPackaged) {
      return process.resourcesPath
    }

    // 尝试访问 electron app（仅在主进程中有效）
    try {
      const { app } = require('electron')
      return app?.getAppPath?.() ?? process.env.RES_ROOT ?? path.resolve()
    } catch {
      return process.env.RES_ROOT || path.resolve()
    }
  } catch {
    return process.env.RES_ROOT || path.resolve()
  }
}

/** 资源根目录路径 */
const RES_ROOT = getResRoot()

/**
 * 环境变量校验模式
 * Server层配置：模型、TTS、向量、阈值等
 */
const envSchema = z.object({
  /** OpenAI API 密钥（用于兼容旧配置，主模型配置优先从 models 目录读取） */
  OPENAI_API_KEY: z.string().min(1).optional(),
  /** OpenAI API 基础 URL（用于兼容旧配置） */
  OPENAI_API_BASE_URL: z.string().optional(),
  /** OpenAI API 模型名称（用于兼容旧配置，建议使用 models 目录） */
  OPENAI_API_MODEL_NAME: z.string().min(1).optional(),
  /** 主模型配置（对应 models 目录下的文件名，不含 .json） */
  OPENAI_API_MODEL: z.string().min(1),
  /** Fallback 模型列表（逗号分隔，对应 models 目录下的文件名） */
  OPENAI_API_MODEL_FALLBACKS: z.string().optional(),

  /** 摘要模型配置（对应 models 目录下的文件名，不含 .json） */
  SUMMARIZATION_API_MODEL: z.string().optional(),

  /** 工作区路径 */
  WORKSPACE: z.string().min(1),
  /** 是否启用 TTS (0: 禁用, 1: 启用) */
  ENABLE_TTS: z.coerce.number().default(0),
  /** 自动插入间隔 (秒) */
  AUTO_INSERT_INTERVAL: z.coerce.number().default(120),
  /** 摘要更新触发的对话轮数 */
  SUMMARY_UPDATE_COUNT: z.coerce.number().default(30),
  /** 强制摘要的 token 阈值，超过此值必须触发摘要 */
  SUMMARY_FORCE_TOKEN: z.coerce.number().default(60000),
  /** 摘要基础阈值，达到此值触发摘要（默认45k） */
  SUMMARY_BASE_TOKEN: z.coerce.number().default(45000),
  /** 极限阈值，超过此值强制触发摘要（默认100k） */
  EXTREME_THRESHOLD: z.coerce.number().default(100000),

  /** 笔记触发阈值（默认20K token） */
  NOTES_TRIGGER_TOKEN: z.coerce.number().default(20000),
  /** 会话笔记最大大小（默认20K） */
  NOTES_MAX_SIZE: z.coerce.number().default(20000),
  /** 笔记触发对话轮数（默认15轮） */
  NOTES_TRIGGER_ROUNDS: z.coerce.number().default(15),
  /** 极限压缩时保留 buffer 尾部比例（默认30%） */
  BUFFER_TAIL_PERCENT: z.coerce.number().default(30),
  /** 工具保留策略recent距离（距尾部消息数，默认10） */
  TOOL_RETENTION_RECENT_THRESHOLD: z.coerce.number().default(10),
  /** 工具密度触发阈值（0-1，默认0.6） */
  TOOL_DENSITY_TRIGGER: z.coerce.number().default(0.6),
  /** 情感密度触发阈值（0-1，默认0.4） */
  EMOTIONAL_DENSITY_TRIGGER: z.coerce.number().default(0.4),
  /** 密度触发最低轮数（默认5） */
  DENSITY_TRIGGER_MIN_ROUNDS: z.coerce.number().default(5),
  /** 场景边界验证-工具密度跳变阈值（0-1，默认0.3） */
  SCENE_BOUNDARY_TOOL_DENSITY_JUMP: z.coerce.number().default(0.3),
  /** 场景边界验证-时间间隔阈值（秒，默认180） */
  SCENE_BOUNDARY_TIME_GAP_SECONDS: z.coerce.number().default(180),
  /** 场景边界验证-检测窗口大小（轮数，默认5） */
  SCENE_BOUNDARY_WINDOW_SIZE: z.coerce.number().default(5),
  /** 笔记片段合并阈值（默认3） */
  SEGMENT_MERGE_THRESHOLD: z.coerce.number().default(3),
  /** 会话笔记整合触发阈值（token数，默认20k） */
  SESSION_NODE_MAX_TOKENS: z.coerce.number().default(20000),
  /** 情感事件最大保留条数（默认30） */
  EMOTIONAL_EVENTS_MAX: z.coerce.number().default(30),
  /** 场景边界压缩-保留的重叠轮数（默认3） */
  SCENE_BOUNDARY_OVERLAP_ROUNDS: z.coerce.number().default(3),
  /** 碎片记忆保留时间（小时，默认72） */
  FRAGMENT_MEMORY_RETENTION_HOURS: z.coerce.number().default(72),

  /** 摘要后保留的上下文 token 数 */
  SUMMARY_KEEP_TOKEN: z.coerce.number().default(8000),
  /** 每个图的最大工具调用次数 */
  MAX_TOOL_CALLS_PER_GRAPH: z.coerce.number().default(20),
  /** 文件读取最大字符数（同时用于工具响应截断） */
  FILE_READ_MAX_CHARS: z.coerce.number().default(10240),
  /** 文件读取最大行数 */
  FILE_READ_MAX_LINES: z.coerce.number().default(2000),
  /** 文件读取默认行数 */
  FILE_READ_DEFAULT_LIMIT: z.coerce.number().default(500),
  /** 清理超过多少天的旧文件 */
  CLEANUP_OLD_FILES_DAYS: z.coerce.number().default(7),
  /** 工具调用限制配置 JSON 字符串 */
  TOOL_CALL_LIMITS: z.string().optional().default('{}'),
  /** TTS 提供商 ('edge', 'dolphin', 'bailian' 或 'minimax') */
  TTS_PROVIDER: z.enum(['edge', 'dolphin', 'bailian', 'minimax']).optional().default('edge'),
  /** Edge TTS 声音名称 */
  EDGE_TTS_VOICE: z.string().optional().default('zh-CN-XiaoxiaoNeural'),
  /** Dolphin TTS 令牌 */
  DOLPHIN_TTS_TOKEN: z.string().optional(),
  /** Dolphin TTS 语音 ID */
  DOLPHIN_TTS_VOICE_ID: z.coerce.number().optional().default(106),
  /** Dolphin TTS 快速语速 */
  DOLPHIN_TTS_SPEED_FAST: z.coerce.number().optional().default(1.5),
  /** Dolphin TTS 正常语速 */
  DOLPHIN_TTS_SPEED_NORMAL: z.coerce.number().optional().default(1.1),
  /** Dolphin TTS 慢速语速 */
  DOLPHIN_TTS_SPEED_SLOW: z.coerce.number().optional().default(0.9),
  /** Dolphin TTS 服务器主机名 */
  DOLPHIN_TTS_HOSTNAME: z.string().optional().default('u95167-8ncb-3637bf8b.bjb1.seetacloud.com'),
  /** Dolphin TTS 服务器端口 */
  DOLPHIN_TTS_PORT: z.coerce.number().optional().default(8443),
  /** Dolphin TTS API 路径 */
  DOLPHIN_TTS_PATH: z.string().optional().default('/flashsummary/tts'),
  /** 阿里百炼 TTS API Key */
  BAILIAN_TTS_API_KEY: z.string().optional(),
  /** 阿里百炼 TTS 模型 */
  BAILIAN_TTS_MODEL: z.string().optional().default('cosyvoice-v3-flash'),
  /** 阿里百炼 TTS 音色 */
  BAILIAN_TTS_VOICE: z.string().optional().default('longanyang'),
  /** MiniMax TTS API Key */
  MINIMAX_TTS_API_KEY: z.string().optional(),
  /** MiniMax TTS GroupId */
  MINIMAX_TTS_GROUP_ID: z.string().optional(),
  /** MiniMax TTS 模型 */
  MINIMAX_TTS_MODEL: z.string().optional().default('speech-02-turbo'),
  /** MiniMax TTS 音色 */
  MINIMAX_TTS_VOICE: z.string().optional().default('maincommon'),
  /** MiniMax TTS API 地址，默认国内版 api.minimaxi.com */
  MINIMAX_TTS_BASE_URL: z.string().optional().default('https://api.minimaxi.com'),
  /** 向量嵌入 API 密钥 */
  EMBEDDING_API_KEY: z.string().optional(),
  /** 向量嵌入 API 基础 URL */
  EMBEDDING_API_BASE_URL: z.string().optional().default('http://127.0.0.1:1234'),
  /** 向量嵌入模型名称 */
  EMBEDDING_MODEL_NAME: z.string().optional().default('text-embedding-nomic-embed-text-v1.5'),
  /** 向量嵌入维度 */
  EMBEDDING_DIMENSION: z.coerce.number().optional().default(768),
  /** 是否启用向量嵌入 (0: 禁用, 1: 启用) */
  EMBEDDING_ENABLED: z.coerce.number().default(1),
  /** 是否启用空闲主动交互 (0: 禁用, 1: 启用) */
  IDLE_PROACTIVE_ENABLED: z.coerce.number().default(1),
  /** 空闲主动交互检查间隔 (秒) */
  IDLE_PROACTIVE_CHECK_INTERVAL: z.coerce.number().default(60),
  /** 空闲主动交互阈值 (秒) */
  IDLE_PROACTIVE_THRESHOLD: z.coerce.number().default(60),
  /** Socket 服务器端口 */
  SOCKET_PORT: z.coerce.number().default(9172),
  /** 自定义提示词模板文件路径 */
  CUSTOM_PROMPT_FILE: z.string().optional(),
  /** 艾特转发路由配置，格式：名称1:地址1,名称2:地址2 */
  MENTION_ROUTES: z.string().optional(),
  /** 艾特转发时显示的发送者名称 */
  MENTION_SENDER_NAME: z.string().optional(),
  /** 会话笔记JSON解析失败重试次数 */
  SESSION_NOTES_RETRY_COUNT: z.coerce.number().default(5),
  /** 系统级MCP配置文件路径，默认 ~/.agent/mcp.json */
  MCP_SYSTEM_CONFIG_PATH: z.string().optional(),
})

/**
 * 加载环境变量
 * 如果是子进程模式，环境变量已由父进程传递，跳过文件加载
 */
const loadEnv = () => {
  // 如果是子进程模式，环境变量已由主进程传递，不需要重新加载 .env 文件
  if (process.env.SERVER_MODE === 'child_process') {
    console.log('[ServerEnv] 运行在子进程模式，使用父进程传递的环境变量')
    return
  }

  // 独立运行模式，需要加载 .env 文件
  const envFileName = process.env.ENV_FILE || '.env'
  const isPackaged = isPackagedEnv()
  const envPath = isPackaged
    ? path.join(process.resourcesPath, envFileName)
    : path.join(RES_ROOT, envFileName)
  try {
    config({ path: envPath, override: false })
    console.log(`[ServerEnv] 已加载环境变量: ${envPath}`)
  } catch (e) {
    console.warn(`[ServerEnv] 从 ${envPath} 加载失败，尝试当前工作目录`)
    config({ path: path.join(process.cwd(), '.env'), override: false })
  }
}

loadEnv()

/**
 * 合并配置优先级：命令行参数 > 环境变量 > .env 配置文件
 * 将命令行参数覆盖到 process.env 中（如果提供了值）
 */
const mergeConfigPriority = (): void => {
  if (Object.keys(CLI_ARGS).length === 0) return

  console.log('[ServerEnv] 应用命令行参数覆盖（优先级最高）:')
  for (const [key, value] of Object.entries(CLI_ARGS)) {
    const displayValue =
      key.includes('KEY') || key.includes('TOKEN') || key.includes('SECRET') ? '***' : value
    console.log(`  ${key}=${displayValue}`)
    // 命令行参数优先级最高，覆盖环境变量
    process.env[key] = value
  }
}

mergeConfigPriority()

/** 解析后的环境变量 */
export const env = envSchema.parse(process.env)

/**
 * 工具调用限制配置
 * 从 TOOL_CALL_LIMITS 环境变量解析得到
 * @deprecated 使用 configManager.get('TOOL_CALL_LIMITS') 配合 JSON.parse 以支持热重载
 */
export const toolCallLimits: Record<string, number> = (() => {
  try {
    return JSON.parse(env.TOOL_CALL_LIMITS)
  } catch {
    return {}
  }
})()

/**
 * 路径配置对象
 * 提供各种目录和文件的路径访问
 */
export const paths = {
  /**
   * 资源根目录
   */
  get RES_ROOT() {
    return RES_ROOT
  },
  /**
   * 工作区根目录
   */
  get WORKSPACE_ROOT() {
    return path.isAbsolute(env.WORKSPACE) ? env.WORKSPACE : path.resolve(RES_ROOT, env.WORKSPACE)
  },
  /**
   * 提示词目录
   */
  get PROMPT_DIR() {
    return path.join(this.WORKSPACE_ROOT, 'prompt')
  },
  /**
   * 技能目录
   */
  get SKILLS_DIR() {
    return path.join(this.WORKSPACE_ROOT, 'skills')
  },
  /**
   * 子代理目录
   */
  get AGENTS_DIR() {
    return path.join(this.WORKSPACE_ROOT, 'agents')
  },
  /**
   * 数据库目录
   */
  get DB_DIR() {
    return path.join(this.WORKSPACE_ROOT, 'db')
  },
  /**
   * 配置文件路径
   */
  get CONFIG() {
    return path.join(this.WORKSPACE_ROOT, 'config.json')
  },
  /**
   * 缓存目录
   */
  get CACHE_DIR() {
    return path.join(this.WORKSPACE_ROOT, 'cache')
  },
  /**
   * TTS 缓存目录
   */
  get TTS_CACHE_DIR() {
    return path.join(this.CACHE_DIR, 'tts')
  },
  /**
   * MCP 配置文件路径
   */
  get MCP_CONFIG() {
    return path.join(this.WORKSPACE_ROOT, 'mcp.json')
  },
}

// 导出配置管理器
export { configManager } from './config-manager'
export type { ReloadableConfig, ConfigChangeEvent } from './config-manager'
