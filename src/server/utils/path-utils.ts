import path from 'node:path'
import { paths } from '../config/env'

/**
 * 路径处理和验证工具类
 * 提供路径安全验证和处理功能
 */

/**
 * 验证路径是否在工作空间内
 * 用于安全检查，防止访问工作空间外的文件
 * @param filePath 待验证的文件路径
 * @returns 是否在工作空间内
 */
export function isWorkspacePath(filePath: string): boolean {
  const normalizedPath = path.normalize(path.resolve(filePath))
  const normalizedWorkspace = path.normalize(paths.WORKSPACE_ROOT)
  return normalizedPath.startsWith(normalizedWorkspace)
}

/**
 * 规范化路径
 * 将路径转换为标准格式，解析相对路径和符号链接
 * @param filePath 待规范化的路径
 * @returns 规范化后的路径
 */
export function normalizePath(filePath: string): string {
  return path.normalize(path.resolve(filePath))
}

/**
 * 连接路径片段
 * 安全地连接多个路径片段
 * @param paths 路径片段数组
 * @returns 连接后的路径
 */
export function joinPaths(...paths: string[]): string {
  return path.join(...paths)
}
