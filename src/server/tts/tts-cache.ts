import { createHash } from 'crypto'
import { readFile, writeFile, access, mkdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { paths } from '../config/env'
import { logger } from '../utils/logger'
import type { TTSResult } from './tts'

export interface TTSCacheEntry {
  text: string
  speed: string
  voiceId?: number
  audioBuffer: Buffer
  duration: number
  createdAt: number
}

export interface TTSCacheMeta {
  text: string
  speed: string
  voiceId?: number
  duration: number
  createdAt: number
}

function generateCacheKey(text: string, speed: string, voiceId?: number): string {
  const content = `${text}|${speed}|${voiceId || 'default'}`
  return createHash('md5').update(content).digest('hex')
}

function getCacheFilePath(cacheKey: string): { audioPath: string; metaPath: string } {
  const cacheDir = paths.TTS_CACHE_DIR
  return {
    audioPath: path.join(cacheDir, `${cacheKey}.mp3`),
    metaPath: path.join(cacheDir, `${cacheKey}.json`),
  }
}

async function ensureCacheDir(): Promise<void> {
  const cacheDir = paths.TTS_CACHE_DIR
  try {
    await access(cacheDir, constants.F_OK)
  } catch {
    await mkdir(cacheDir, { recursive: true })
    logger.info({ cacheDir }, 'TTS cache directory created')
  }
}

export async function getTTSCache(
  text: string,
  speed: string,
  voiceId?: number,
): Promise<TTSResult | null> {
  const cacheKey = generateCacheKey(text, speed, voiceId)
  const { audioPath, metaPath } = getCacheFilePath(cacheKey)

  try {
    const [audioBuffer, metaJson] = await Promise.all([
      readFile(audioPath),
      readFile(metaPath, 'utf-8'),
    ])

    const meta: TTSCacheMeta = JSON.parse(metaJson)

    logger.debug({ cacheKey, text: text.substring(0, 50) }, 'TTS cache hit')

    return {
      audioBuffer,
      duration: meta.duration,
    }
  } catch {
    return null
  }
}

export async function setTTSCache(
  text: string,
  speed: string,
  audioBuffer: Buffer,
  duration: number,
  voiceId?: number,
): Promise<void> {
  await ensureCacheDir()

  const cacheKey = generateCacheKey(text, speed, voiceId)
  const { audioPath, metaPath } = getCacheFilePath(cacheKey)

  const meta: TTSCacheMeta = {
    text,
    speed,
    voiceId,
    duration,
    createdAt: Date.now(),
  }

  await Promise.all([
    writeFile(audioPath, audioBuffer),
    writeFile(metaPath, JSON.stringify(meta, null, 2)),
  ])

  logger.debug({ cacheKey, text: text.substring(0, 50), duration }, 'TTS cache saved')
}

export async function deleteTTSCache(
  text: string,
  speed: string,
  voiceId?: number,
): Promise<boolean> {
  const cacheKey = generateCacheKey(text, speed, voiceId)
  const { audioPath, metaPath } = getCacheFilePath(cacheKey)

  try {
    await Promise.all([unlink(audioPath), unlink(metaPath)])
    logger.debug({ cacheKey }, 'TTS cache deleted')
    return true
  } catch {
    return false
  }
}

export async function clearTTSCache(): Promise<void> {
  const cacheDir = paths.TTS_CACHE_DIR

  try {
    const { readdir, rm } = await import('node:fs/promises')
    const files = await readdir(cacheDir)

    await Promise.all(files.map((file) => rm(path.join(cacheDir, file), { force: true })))

    logger.info({ cacheDir, count: files.length }, 'TTS cache cleared')
  } catch (error) {
    logger.error({ error }, 'Failed to clear TTS cache')
  }
}

export function getTTSCacheKey(text: string, speed: string, voiceId?: number): string {
  return generateCacheKey(text, speed, voiceId)
}
