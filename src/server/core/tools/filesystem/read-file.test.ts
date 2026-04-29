import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, unlink, mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileContent } from './read-file'
import { TOOL_RESPONSE_SEPARATOR } from '../../../utils/tool-response-parser'

function parseResponse(response: string) {
  console.log('=== 原始响应 ===')
  console.log(response)
  console.log('================')

  const separatorIndex = response.indexOf(TOOL_RESPONSE_SEPARATOR)
  if (separatorIndex === -1) {
    return { json: null, rawBody: response }
  }
  const jsonStr = response.substring(0, separatorIndex)
  const rawBody = response.substring(separatorIndex + TOOL_RESPONSE_SEPARATOR.length)
  try {
    const json = JSON.parse(jsonStr)
    return { json, rawBody }
  } catch {
    return { json: null, rawBody: response }
  }
}

describe('read-file', () => {
  const testDir = join(tmpdir(), 'read-file-test-' + Date.now())
  const testFile = join(testDir, 'test.txt')
  const emptyFile = join(testDir, 'empty.txt')
  const binaryFile = join(testDir, 'binary.bin')

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
    // 创建测试文件：100行
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`)
    await writeFile(testFile, lines.join('\n'), 'utf-8')
    // 创建空文件
    await writeFile(emptyFile, '', 'utf-8')
    // 创建二进制文件（包含\0）
    await writeFile(
      binaryFile,
      Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]),
    )
  })

  afterAll(async () => {
    try {
      await unlink(testFile)
      await unlink(emptyFile)
      await unlink(binaryFile)
      await rmdir(testDir)
    } catch {
      // 忽略清理错误
    }
  })

  describe('head mode', () => {
    it('从开头读取默认参数', async () => {
      console.log('\n>>> head mode, offset=1, limit=default')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'head',
      })

      const { json, rawBody } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))
      console.log('rawBody前200字符:', rawBody?.substring(0, 200))

      expect(json?.success).toBe(true)
      expect(json?.readLines).toBeGreaterThan(0)
      expect(rawBody).toContain('Line 1')
    })

    it('指定offset和limit', async () => {
      console.log('\n>>> head mode, offset=10, limit=5')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'head',
        offset: 10,
        limit: 5,
      })

      const { json, rawBody } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))
      console.log('rawBody:', rawBody)

      expect(json?.success).toBe(true)
      expect(json?.readLines).toBe(5)
      expect(rawBody).toContain('Line 10')
      expect(rawBody).toContain('Line 14')
    })

    it('分页提示', async () => {
      console.log('\n>>> head mode, offset=1, limit=10')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'head',
        offset: 1,
        limit: 10,
      })

      const { json } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))

      expect(json?.success).toBe(true)
      expect(json?.hasMore).toBe(true)
      expect(json?.nextOffset).toBe(11)
    })

    it('空文件', async () => {
      console.log('\n>>> head mode, empty file')
      const result = await readFileContent({
        file_path: emptyFile,
        mode: 'head',
      })

      const { json, rawBody } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))
      console.log('rawBody:', JSON.stringify(rawBody))

      expect(json?.success).toBe(true)
      expect(json?.readLines).toBe(0)
      expect(rawBody).toBe('')
    })
  })

  describe('tail mode', () => {
    it('从末尾读取默认参数', async () => {
      console.log('\n>>> tail mode, offset=1, limit=default')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'tail',
      })

      const { json, rawBody } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))
      console.log('rawBody前200字符:', rawBody?.substring(0, 200))

      expect(json?.success).toBe(true)
      expect(json?.readLines).toBeGreaterThan(0)
      expect(rawBody).toContain('Line 100')
    })

    it('指定offset读取倒数N行', async () => {
      console.log('\n>>> tail mode, offset=10, limit=5')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'tail',
        offset: 10,
        limit: 5,
      })

      const { json, rawBody } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))
      console.log('rawBody:', rawBody)

      expect(json?.success).toBe(true)
      expect(json?.readLines).toBe(5)
      // tail模式: offset相对于底部，行号从offset累加
      // offset=10, limit=5, 读取14行(87-100)，取前5行 = 87,88,89,90,91
      // 显示顺序正序（从旧到新），行号 10,11,12,13,14
      expect(rawBody).toContain('010| Line 87')
      expect(rawBody).toContain('014| Line 91')
    })

    it('tail模式没有hasMore', async () => {
      console.log('\n>>> tail mode, hasMore check')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'tail',
        limit: 5,
      })

      const { json } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))

      expect(json?.success).toBe(true)
      expect(json?.hasMore).toBe(false)
    })
  })

  describe('行号', () => {
    it('head模式行号正确', async () => {
      console.log('\n>>> head mode line numbers, offset=5, limit=3')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'head',
        offset: 5,
        limit: 3,
      })

      const { rawBody } = parseResponse(result)
      console.log('rawBody:', rawBody)

      expect(rawBody).toContain('005| Line 5')
      expect(rawBody).toContain('006| Line 6')
      expect(rawBody).toContain('007| Line 7')
    })

    it('tail模式行号从offset累加', async () => {
      console.log('\n>>> tail mode line numbers, offset=3, limit=3')
      const result = await readFileContent({
        file_path: testFile,
        mode: 'tail',
        offset: 3,
        limit: 3,
      })

      const { rawBody } = parseResponse(result)
      console.log('rawBody:', rawBody)

      // tail模式: offset=3, limit=3, 读取5行(96-100)，取前3行 = 96,97,98
      // 显示顺序正序（从旧到新），行号从3累加: 003| 004| 005|
      expect(rawBody).toContain('003| Line 96')
      expect(rawBody).toContain('004| Line 97')
      expect(rawBody).toContain('005| Line 98')
    })
  })

  describe('错误处理', () => {
    it('文件不存在', async () => {
      console.log('\n>>> error: file not found')
      const result = await readFileContent({
        file_path: join(testDir, 'non-existent.txt'),
        mode: 'head',
      })

      const { json } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))

      expect(json?.success).toBe(false)
    })

    it('路径是目录', async () => {
      console.log('\n>>> error: path is directory')
      const result = await readFileContent({
        file_path: testDir,
        mode: 'head',
      })

      const { json } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))

      expect(json?.success).toBe(false)
    })

    it('二进制文件', async () => {
      console.log('\n>>> error: binary file')
      const result = await readFileContent({
        file_path: binaryFile,
        mode: 'head',
      })

      const { json } = parseResponse(result)
      console.log('JSON:', JSON.stringify(json, null, 2))

      expect(json?.success).toBe(false)
      expect(json?.errorType).toBe('binary_file')
    })
  })
})
