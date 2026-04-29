import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { logger } from './logger'

/**
 * JSON文件读写工具类
 * 提供从文件读取JSON数据和将JSON数据写入文件的功能
 * 支持自动创建目录和文件
 */

/**
 * 从JSON文件读取数据并转换为指定类型
 * 如果文件或目录不存在，会自动创建
 * @param filePath 文件路径
 * @returns 解析后的JSON数据
 */
export async function readJsonFromFile<T>(filePath: string): Promise<T> {
  const normalizedPath = path.normalize(path.resolve(filePath))
  const dir = path.dirname(normalizedPath)

  try {
    await access(normalizedPath)
    const content = await readFile(normalizedPath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    await mkdir(dir, { recursive: true })
    logger.info(`[JsonFileUtils] 创建文件 ${normalizedPath}`)
    const emptyData = [] as unknown as T
    await writeFile(normalizedPath, JSON.stringify(emptyData), 'utf-8')
    return emptyData
  }
}

/**
 * 将数据写入JSON文件
 * 自动创建目录和文件
 * @param filePath 文件路径
 * @param data 要写入的数据
 */
export async function writeJsonToFile<T>(filePath: string, data: T): Promise<void> {
  const normalizedPath = path.normalize(path.resolve(filePath))
  const dir = path.dirname(normalizedPath)

  await mkdir(dir, { recursive: true })
  await writeFile(normalizedPath, JSON.stringify(data, null, 2), 'utf-8')
}
