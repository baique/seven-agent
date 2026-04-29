import {
  mkdir,
  access,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  copyFile,
  readdir,
} from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { paths } from '../config/env'
import { logger } from './logger'
import { CTX } from '../core/state/context'
import { nanoid } from 'nanoid'

/**
 * 命令行提示用户输入
 * @param question - 提示问题
 * @returns 用户输入
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export async function readFile(filePath: string): Promise<string> {
  try {
    const content = await fsReadFile(filePath, 'utf-8')
    logger.info(`[Workspace] 读取文件成功: ${filePath}`)
    return content
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[Workspace] 读取文件失败: ${filePath}, 错误: ${errorMsg}`)
    throw new Error(`读取文件失败: ${errorMsg}`)
  }
}

export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await access(dir)
    return false
  } catch {
    await mkdir(dir, { recursive: true })
    logger.info(`[Workspace] 创建目录: ${dir}`)
    return true
  }
}

export async function ensureFile(filePath: string, content: string): Promise<boolean> {
  try {
    await access(filePath)
    return false
  } catch {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, content, 'utf-8')
    logger.info(`[Workspace] 创建文件: ${filePath}`)
    return true
  }
}

/**
 * 检查是否为开发模式
 */
function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * 复制目录
 * @param src 源目录
 * @param dest 目标目录
 * @param skipExisting 是否跳过已存在的文件，dev模式为false（覆盖），生产模式为true（不覆盖）
 */
async function copyDirectory(src: string, dest: string, skipExisting?: boolean): Promise<void> {
  try {
    await access(src)
  } catch {
    logger.warn(`[Workspace] 源目录不存在: ${src}`)
    return
  }

  // 如果没有指定skipExisting，根据环境判断
  const shouldSkip = skipExisting ?? !isDevMode()

  // 确保目标目录存在
  await ensureDir(dest)

  const entries = await readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      // 递归复制子目录
      await copyDirectory(srcPath, destPath, skipExisting)
    } else {
      try {
        // 检查目标文件是否已存在
        if (shouldSkip) {
          try {
            await access(destPath)
            logger.debug(`[Workspace] 跳过已存在文件: ${destPath}`)
            continue
          } catch {
            // 文件不存在，继续复制
          }
        }

        await copyFile(srcPath, destPath)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.warn(`[Workspace] 复制文件失败: ${srcPath} -> ${destPath}, ${errorMsg}`)
      }
    }
  }
}

/**
 * 初始化工作空间默认数据
 * 从 resources/workspace 复制到用户工作空间
 * dev模式：覆盖已有文件
 * 生产模式：不覆盖已有文件
 */
async function initWorkspaceDefaults(): Promise<void> {
  const defaultWorkspaceDir = path.join(paths.RES_ROOT, 'resources', 'workspace')

  try {
    await access(defaultWorkspaceDir)
  } catch {
    logger.warn(`[Workspace] 默认工作空间目录不存在: ${defaultWorkspaceDir}`)
    return
  }

  const devMode = isDevMode()

  // 遍历 resources/workspace 下的所有目录并复制
  const entries = await readdir(defaultWorkspaceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const srcDir = path.join(defaultWorkspaceDir, entry.name)
      const destDir = path.join(paths.WORKSPACE_ROOT, entry.name)
      await copyDirectory(srcDir, destDir)
    }
  }

  logger.info(`[Workspace] 工作空间默认数据初始化完成 (dev模式: ${devMode})`)
}

export async function initWorkspace(forceRecreate?: boolean): Promise<void> {
  logger.info('[Workspace] 开始初始化工作空间')

  const workspaceRoot = paths.WORKSPACE_ROOT
  const promptDir = paths.PROMPT_DIR
  const skillsDir = paths.SKILLS_DIR
  const agentsDir = paths.AGENTS_DIR
  const dbDir = paths.DB_DIR

  logger.info(`[Workspace] workspaceRoot: ${workspaceRoot}`)
  logger.info(`[Workspace] RES_ROOT: ${paths.RES_ROOT}`)
  logger.info(`[Workspace] dev模式: ${isDevMode()}`)

  // 如果强制重建就先删除
  if (forceRecreate) {
    // 让用户输入确认
    const confirm = await prompt('确认强制重建工作空间吗？ (y/n)')
    if (confirm !== 'y') {
      logger.info(`[Workspace] 用户取消强制重建`)
      return
    }
    const { rm } = await import('node:fs/promises')
    try {
      await rm(workspaceRoot, { recursive: true, force: true })
      logger.info(`[Workspace] 强制重建: 删除工作空间 ${workspaceRoot}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.warn(`[Workspace] 删除工作空间失败: ${errorMsg}`)
    }
  }

  // 创建基础目录
  await ensureDir(workspaceRoot)
  await ensureDir(promptDir)
  await ensureDir(skillsDir)
  await ensureDir(agentsDir)
  await ensureDir(dbDir)

  // 初始化默认数据
  await initWorkspaceDefaults()

  // 初始化JSON记忆管理器
  const { jsonMemoryManager } = await import('../memory/json-memory-manager')
  await jsonMemoryManager.initialize(workspaceRoot)

  await CTX.init()

  // 启动 agents 目录监听（延迟导入避免循环依赖）
  const { startAgentsWatcher } = await import('../core/agents')
  startAgentsWatcher()

  logger.info('[Workspace] 工作空间初始化完成')
}

export function getPromptPath(fileName: string): string {
  return path.join(paths.PROMPT_DIR, fileName)
}

export function getSkillPath(skillName: string): string {
  return path.join(paths.SKILLS_DIR, skillName)
}

export function getDbPath(dbName: string): string {
  return path.join(paths.DB_DIR, dbName)
}

export async function saveLongContentToTempFile(
  content: string,
  prefix: string = 'tool',
): Promise<string> {
  try {
    const tempDir = path.join(paths.CACHE_DIR, 'temp')
    await ensureDir(tempDir)

    const timestamp = Date.now()
    const randomId = nanoid(8)
    const fileName = `${prefix}-${timestamp}-${randomId}.txt`
    const filePath = path.join(tempDir, fileName)

    await fsWriteFile(filePath, content, 'utf-8')

    logger.info(`[Workspace] 长内容保存到临时文件: ${filePath} (长度: ${content.length})`)

    return filePath
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[Workspace] 保存长内容到临时文件失败: ${errorMsg}`)
    throw new Error(`保存长内容到临时文件失败: ${errorMsg}`)
  }
}

export { fsWriteFile as writeFile }
