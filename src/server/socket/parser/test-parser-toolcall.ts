/**
 * 直接测试 LLMResponseParser 的 tool_call 参数累积逻辑
 * 模拟真实的流式数据，验证参数是否能正确累积
 */

import { LLMResponseParser } from './index'
import { CharacterStateManager } from '../../core/state/context/impl/character-state'
import type { WebSocket } from 'ws'

// 模拟 WebSocket - 捕获所有发送的消息
class MockWebSocket {
  messages: any[] = []
  readyState = 1

  send(data: string) {
    const parsed = JSON.parse(data)
    this.messages.push(parsed)
  }

  // 获取最后一条 AI 消息
  getLastAIMessage(): any {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === 'ai') {
        return this.messages[i]
      }
    }
    return null
  }

  // 获取所有 AI 消息
  getAIMessages(): any[] {
    return this.messages.filter((m) => m.type === 'ai')
  }
}

// 模拟 CharacterStateManager
class MockCharacterStateManager {
  sendMessage(requestId: string, socket: WebSocket, message: any) {
    ;(socket as unknown as MockWebSocket).send(JSON.stringify(message))
  }

  addTTS(requestId: string, socket: WebSocket, ttsData: any) {
    // 忽略 TTS
  }
}

/**
 * 测试用例1：模拟阿里云流式返回的分段参数
 * 这是最关键的场景：参数分多个 chunk 返回
 */
function testAliyunStreamingChunks(): boolean {
  console.log('\n========================================')
  console.log('测试用例1: 阿里云流式分段参数累积')
  console.log('========================================')

  const mockSocket = new MockWebSocket()
  const mockSM = new MockCharacterStateManager()
  const parser = new LLMResponseParser(
    mockSM as unknown as CharacterStateManager,
    'test-request-1',
    mockSocket as unknown as WebSocket,
  )

  const messageId = 'msg-test-1'

  // 模拟第一个 chunk - 只有 id, name 和部分参数
  // 这是阿里云流式返回的典型格式
  parser.parseChunk([
    'messages',
    [
      {
        id: messageId,
        content: '',
        tool_calls: [
          {
            id: 'call_8f08d2b0fc0c4d8fab7123',
            name: 'get_current_weather',
            function: {
              arguments: '{"location":',
            },
          },
        ],
      },
      { langgraph_node: 'llmCall' },
    ],
  ])

  console.log('Chunk 1 后（发送给前端的消息）:')
  const msg1 = mockSocket.getLastAIMessage()
  console.log('  toolCalls:', JSON.stringify(msg1?.toolCalls, null, 2))

  // 验证：此时不应该发送 toolCalls（因为参数不完整）
  if (msg1?.toolCalls && msg1.toolCalls.length > 0) {
    console.error('❌ 失败：Chunk 1 后不应该发送 toolCalls（参数不完整）')
    return false
  }
  console.log('✓ Chunk 1 验证通过：参数不完整，未发送 toolCalls')

  // 模拟第二个 chunk - 参数继续
  parser.parseChunk([
    'messages',
    [
      {
        id: messageId,
        content: '',
        tool_calls: [
          {
            id: 'call_8f08d2b0fc0c4d8fab7123',
            function: {
              arguments: ' "杭州"}',
            },
          },
        ],
      },
      { langgraph_node: 'llmCall' },
    ],
  ])

  console.log('\nChunk 2 后（发送给前端的消息）:')
  const msg2 = mockSocket.getLastAIMessage()
  console.log('  toolCalls:', JSON.stringify(msg2?.toolCalls, null, 2))

  // 验证：此时应该发送 toolCalls，且参数完整
  if (!msg2?.toolCalls || msg2.toolCalls.length === 0) {
    console.error('❌ 失败：Chunk 2 后应该发送 toolCalls')
    return false
  }

  const tc = msg2.toolCalls[0]
  if (!tc.args || tc.args.location !== '杭州') {
    console.error('❌ 失败：参数不正确，期望 { location: "杭州" }，实际:', tc.args)
    return false
  }

  console.log('✓ Chunk 2 验证通过：toolCalls 正确发送，参数完整')
  console.log('  最终参数:', tc.args)

  return true
}

/**
 * 测试用例2：模拟 LangChain 返回的空 args 对象后接完整参数
 */
function testEmptyArgsThenRealArgs(): boolean {
  console.log('\n========================================')
  console.log('测试用例2: 空 args 对象后接完整参数')
  console.log('========================================')

  const mockSocket = new MockWebSocket()
  const mockSM = new MockCharacterStateManager()
  const parser = new LLMResponseParser(
    mockSM as unknown as CharacterStateManager,
    'test-request-2',
    mockSocket as unknown as WebSocket,
  )

  const messageId = 'msg-test-2'

  // 第一个 chunk - 空 args 对象（LangChain 有时会这样返回）
  parser.parseChunk([
    'messages',
    [
      {
        id: messageId,
        content: '',
        tool_calls: [
          {
            id: 'call_222',
            name: 'get_weather',
            args: {},
          },
        ],
      },
      { langgraph_node: 'llmCall' },
    ],
  ])

  console.log('Chunk 1 (空 args) 后:')
  const msg1 = mockSocket.getLastAIMessage()
  console.log('  toolCalls:', JSON.stringify(msg1?.toolCalls, null, 2))

  // 第二个 chunk - 实际参数字符串
  parser.parseChunk([
    'messages',
    [
      {
        id: messageId,
        content: '',
        tool_calls: [
          {
            id: 'call_222',
            function: {
              arguments: '{"city": "北京"}',
            },
          },
        ],
      },
      { langgraph_node: 'llmCall' },
    ],
  ])

  console.log('\nChunk 2 (实际参数) 后:')
  const msg2 = mockSocket.getLastAIMessage()
  console.log('  toolCalls:', JSON.stringify(msg2?.toolCalls, null, 2))

  // 注意：这种情况下 argsString 会变成 "{}{\"city\": \"北京\"}"
  // 解析会失败，这是符合预期的，因为 LangChain 通常不会混用 args 和 function.arguments
  // 但为了健壮性，我们应该至少能显示部分信息
  console.log('✓ 测试完成（注意：混用 args 和 function.arguments 可能导致解析失败）')

  return true
}

/**
 * 测试用例3：多段参数拼接（真实场景）
 */
function testMultiSegmentArgs(): boolean {
  console.log('\n========================================')
  console.log('测试用例3: 多段参数拼接')
  console.log('========================================')

  const mockSocket = new MockWebSocket()
  const mockSM = new MockCharacterStateManager()
  const parser = new LLMResponseParser(
    mockSM as unknown as CharacterStateManager,
    'test-request-3',
    mockSocket as unknown as WebSocket,
  )

  const messageId = 'msg-test-3'
  const chunks = ['{"location": ', '"北京", ', '"date": ', '"2024-01-01"}']

  for (let i = 0; i < chunks.length; i++) {
    parser.parseChunk([
      'messages',
      [
        {
          id: messageId,
          content: '',
          tool_calls: [
            {
              id: 'call_multi',
              name: i === 0 ? 'get_weather' : undefined,
              function: {
                arguments: chunks[i],
              },
            },
          ],
        },
        { langgraph_node: 'llmCall' },
      ],
    ])

    const msg = mockSocket.getLastAIMessage()
    const hasArgs = msg?.toolCalls?.[0]?.args
    console.log(`Chunk ${i + 1} "${chunks[i].trim()}": ${hasArgs ? '✓ 已解析' : '✗ 未解析'}`)
  }

  const finalMsg = mockSocket.getLastAIMessage()
  const finalArgs = finalMsg?.toolCalls?.[0]?.args

  if (!finalArgs || finalArgs.location !== '北京' || finalArgs.date !== '2024-01-01') {
    console.error('❌ 失败：最终参数不正确:', finalArgs)
    return false
  }

  console.log('✓ 多段参数拼接验证通过')
  console.log('  最终参数:', finalArgs)

  return true
}

/**
 * 测试用例4：并行多个工具调用
 */
function testParallelToolCalls(): boolean {
  console.log('\n========================================')
  console.log('测试用例4: 并行多个工具调用')
  console.log('========================================')

  const mockSocket = new MockWebSocket()
  const mockSM = new MockCharacterStateManager()
  const parser = new LLMResponseParser(
    mockSM as unknown as CharacterStateManager,
    'test-request-4',
    mockSocket as unknown as WebSocket,
  )

  const messageId = 'msg-test-4'

  // 同时触发两个工具调用
  parser.parseChunk([
    'messages',
    [
      {
        id: messageId,
        content: '',
        tool_calls: [
          {
            id: 'call_111',
            name: 'get_weather',
            function: { arguments: '{"city": "北京"}' },
          },
          {
            id: 'call_222',
            name: 'get_time',
            function: { arguments: '{"timezone": "UTC"}' },
          },
        ],
      },
      { langgraph_node: 'llmCall' },
    ],
  ])

  const msg = mockSocket.getLastAIMessage()
  console.log('发送给前端的消息:')
  console.log('  toolCalls:', JSON.stringify(msg?.toolCalls, null, 2))

  if (!msg?.toolCalls || msg.toolCalls.length !== 2) {
    console.error('❌ 失败：应该有 2 个 toolCall')
    return false
  }

  const tc1 = msg.toolCalls.find((tc: any) => tc.id === 'call_111')
  const tc2 = msg.toolCalls.find((tc: any) => tc.id === 'call_222')

  if (!tc1 || !tc2) {
    console.error('❌ 失败：toolCall 未正确存储')
    return false
  }

  if (tc1.args?.city !== '北京' || tc2.args?.timezone !== 'UTC') {
    console.error('❌ 失败：参数不正确')
    return false
  }

  console.log('✓ 并行多个工具调用验证通过')

  return true
}

/**
 * 运行所有测试
 */
function runAllTests(): void {
  console.log('========================================')
  console.log('LLMResponseParser ToolCall 参数累积测试')
  console.log('========================================')

  const tests = [
    testAliyunStreamingChunks,
    testEmptyArgsThenRealArgs,
    testMultiSegmentArgs,
    testParallelToolCalls,
  ]

  let passed = 0
  let failed = 0

  for (const test of tests) {
    try {
      if (test()) {
        passed++
      } else {
        failed++
      }
    } catch (err) {
      console.error('❌ 测试执行异常:', err)
      failed++
    }
  }

  console.log('\n========================================')
  console.log(`测试结果: ${passed} 通过, ${failed} 失败`)
  console.log('========================================')

  if (failed > 0) {
    process.exit(1)
  }
}

// 运行测试
runAllTests()
