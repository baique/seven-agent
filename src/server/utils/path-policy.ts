import path from 'node:path'
import fs from 'node:fs'
import { logger } from './logger'

/**
 * 文件系统配置
 */
export interface FsConfig {
  /** 最大文件大小（字节） */
  maxFileSize: number
  /** 最大读取行数 */
  maxReadLines: number
  /** 最大读取大小（字节） */
  maxReadSize: number
}

/**
 * 默认配置
 */
export const defaultFsConfig: FsConfig = {
  maxFileSize: 10 * 1024,
  maxReadLines: 5000,
  maxReadSize: 10 * 1024,
}

/**
 * 路径验证结果
 */
export interface PathValidationResult {
  valid: boolean
  resolvedPath: string
  error?: string
  errorType?: 'path_traversal' | 'invalid_path' | 'file_too_large'
}

/**
 * 解析并规范化路径
 * 处理 ~ 展开、相对路径、绝对路径
 * @param inputPath 输入路径
 * @param basePath 基础路径（用于相对路径解析）
 * @returns 规范化后的绝对路径
 */
export function resolvePath(inputPath: string, basePath?: string): string {
  let resolved = inputPath

  if (inputPath.startsWith('~/') || inputPath === '~') {
    resolved = path.join(process.env.HOME || process.env.USERPROFILE || '', inputPath.slice(1))
  } else if (!path.isAbsolute(inputPath)) {
    resolved = path.resolve(basePath || process.cwd(), inputPath)
  }

  return path.normalize(resolved)
}

/**
 * 验证路径
 * @param inputPath 输入路径
 * @param basePath 基础路径
 * @returns 验证结果
 */
export function validatePath(inputPath: string, basePath?: string): PathValidationResult {
  try {
    const resolvedPath = resolvePath(inputPath, basePath)
    return { valid: true, resolvedPath }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[path-policy] 路径验证失败: ${errorMsg}`)
    return {
      valid: false,
      resolvedPath: inputPath,
      error: `路径验证失败: ${errorMsg}`,
      errorType: 'invalid_path',
    }
  }
}

/**
 * 验证文件大小
 * @param filePath 文件路径
 * @param config 配置
 * @returns 验证结果
 */
export function validateFileSize(filePath: string, config: FsConfig): PathValidationResult {
  try {
    const stats = fs.statSync(filePath)
    if (stats.size > config.maxFileSize) {
      return {
        valid: false,
        resolvedPath: filePath,
        error: `文件过大: ${formatBytes(stats.size)}，最大允许: ${formatBytes(config.maxFileSize)}`,
        errorType: 'file_too_large',
      }
    }
    return { valid: true, resolvedPath: filePath }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return {
      valid: false,
      resolvedPath: filePath,
      error: `无法获取文件大小: ${errorMsg}`,
      errorType: 'invalid_path',
    }
  }
}

/**
 * 格式化字节数为人类可读格式
 * @param bytes 字节数
 * @returns 格式化后的字符串
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let size = bytes

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

/**
 * 获取文件类型描述
 * @param filePath 文件路径
 * @returns 文件类型描述
 */
export function getFileType(filePath: string): string {
  try {
    const stats = fs.statSync(filePath)
    if (stats.isDirectory()) return 'directory'
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isFile()) {
      const ext = path.extname(filePath).toLowerCase()
      const binaryExtensions = [
        '.exe',
        '.dll',
        '.so',
        '.dylib',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.bmp',
        '.ico',
        '.webp',
        '.mp3',
        '.mp4',
        '.wav',
        '.avi',
        '.mkv',
        '.mov',
        '.zip',
        '.tar',
        '.gz',
        '.rar',
        '.7z',
        '.pdf',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.db',
      ]
      return binaryExtensions.includes(ext) ? 'binary' : 'text'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 创建文件系统配置
 * @param options 部分配置
 * @returns 完整的配置
 */
export function createFsConfig(options?: Partial<FsConfig>): FsConfig {
  return {
    ...defaultFsConfig,
    ...options,
  }
}
