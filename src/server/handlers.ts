import { SocketHandler } from './socket/handler'
import { ResponseBuilder } from './socket/types'
import { createChatHandler } from './socket/handlers/chat'
import { createToolModeChangeHandler } from './socket/handlers/tool-review'
import { createChatCancelHandler } from './socket/handlers/chat-cancel'
import { createBufferCancelHandler } from './socket/handlers/buffer-cancel'
import { getChatCancelManager } from './core/state/chat-cancel'
import { getReviewManager } from './core/review'
import { GLOBAL_MEMORY } from './memory'
import { terminalManagerSingleton } from './terminal'
import { taskManager } from './core/tools/task/task-manager'
import { BUFFER_WINDOW_CONTEXT } from './core/state/context/impl/buffer-window'
import { STATE_CONTEXT } from './core/state/context/impl/character-state'
import { logger } from './utils/logger'

const terminalManager = terminalManagerSingleton

/**
 * 注册所有Socket命令处理器
 * @param handler - SocketHandler实例
 */
export function registerSocketHandlers(handler: SocketHandler): void {
  // Ping命令
  handler.register('ping', async (_data, request) => {
    logger.info({ requestId: request.requestId }, 'Received ping command')
    return ResponseBuilder.success({ pong: true, timestamp: Date.now() })
  })

  // 聊天命令
  handler.register('chat', createChatHandler(STATE_CONTEXT) as any)

  // 指令命令
  handler.register('command', async (data: { message: string }, request, socket) => {
    const rawContent = data.message.replace(/^\//, '')
    logger.info({ requestId: request.requestId, content: rawContent }, '[Cmd] 收到指令')
    if (!socket) {
      return ResponseBuilder.error('Socket not available', 400, request.requestId)
    }

    const [cmd, ...args] = rawContent.split(/\s+/)
    const argRest = args.join(' ')

    if (cmd === 'compress') {
      const { handleExtremeContext } = await import('./core/summary/extreme')
      const result = await handleExtremeContext(true)
      logger.info({ result }, `[Cmd] compress 完成`)
      socket.send(
        JSON.stringify({
          code: 200,
          type: 'command',
          data: { type: 'cmd_compress_result', compressed: result },
          timestamp: Date.now(),
          requestId: request.requestId,
        }) + '\n',
      )
    } else if (cmd === 'new') {
      const { handleExtremeContext } = await import('./core/summary/extreme')
      await handleExtremeContext(true)
      BUFFER_WINDOW_CONTEXT.clear()
      BUFFER_WINDOW_CONTEXT.renewCounter()
      logger.info(`[Cmd] new 完成，Buffer已清空并重置token计数`)
      socket.send(
        JSON.stringify({
          code: 200,
          type: 'command',
          data: { type: 'cmd_new_result', cleared: true },
          timestamp: Date.now(),
          requestId: request.requestId,
        }) + '\n',
      )
    } else if (cmd === 'say' && argRest) {
      const { LLMResponseParser } = await import('./socket/parser')
      const parser = new LLMResponseParser(STATE_CONTEXT, request.requestId as string, socket)
      parser.debugParseAndSend(argRest)
    } else if (rawContent === 'heartbeat') {
      // 心跳指令，无需处理
    } else if (rawContent === 'test_review' || rawContent === '/test_review') {
      logger.info(`[Handlers] 收到测试指令 test_review，测试审查功能`)
      try {
        const reviewManager = getReviewManager()
        logger.info('[Handlers] 获取reviewManager成功')
        const result = await reviewManager.createReview({
          id: 'test-' + Date.now(),
          name: 'write',
          args: {
            filePath: '/tmp/test_review.txt',
            content: '这是一个测试审查请求，用于验证工具审查对话框在参数较多时的显示效果',
            encoding: 'utf-8',
            mode: 'overwrite',
            createDirs: true,
            permissions: '644',
            backup: false,
            validateContent: true,
            maxRetries: 3,
            timeout: 30000,
          },
        })
        logger.info({ result }, '[Handlers] 审查结果')
        socket.send(
          JSON.stringify({
            code: 200,
            type: 'command',
            data: { type: 'test_review_result', ...result },
            timestamp: Date.now(),
            requestId: request.requestId,
          }) + '\n',
        )
      } catch (error: any) {
        logger.error({ error: error.message }, '[Handlers] 审查测试失败')
        socket.send(
          JSON.stringify({
            code: 500,
            type: 'command',
            data: { type: 'test_review_error', error: error.message },
            timestamp: Date.now(),
            requestId: request.requestId,
          }) + '\n',
        )
      }
    } else if (rawContent === 'test_review_auto' || rawContent === '/test_review_auto') {
      logger.info(`收到测试指令 test_review_auto，模拟自动批准`)
      const reviewManager = getReviewManager()
      reviewManager.setMode('auto')
      const result = await reviewManager.createReview({
        id: 'test-auto-' + Date.now(),
        name: 'write',
        args: {
          filePath: '/tmp/test_auto.txt',
          content: '自动批准测试',
        },
      })
      reviewManager.setMode('manual')
      logger.info({ result }, '[TestReviewAuto] 审查结果')
      socket.send(
        JSON.stringify({
          code: 200,
          type: 'command',
          data: { type: 'test_review_auto_result', ...result },
          timestamp: Date.now(),
          requestId: request.requestId,
        }) + '\n',
      )
    } else if (rawContent === 'test_popup' || rawContent === '/test_popup') {
      logger.info(`收到测试指令 test_popup，显示弹窗`)
      const { openWindowTool } = await import('./core/tools/notification')
      const result = await openWindowTool.invoke({
        content: '<h1>测试弹窗</h1><p>这是一个测试弹窗，如果看到这个弹窗，说明测试成功！</p>',
        title: '测试',
        width: 400,
        height: 200,
        duration: 5000,
      })
      logger.info({ result }, '[TestPopup] 弹窗结果')
      socket.send(
        JSON.stringify({
          code: 200,
          type: 'command',
          data: { type: 'test_popup_result', ...JSON.parse(result) },
          timestamp: Date.now(),
          requestId: request.requestId,
        }) + '\n',
      )
    } else if (rawContent === 'test_popup_report' || rawContent === '/test_popup_report') {
      logger.info(`收到测试指令 test_popup_report，显示报告弹窗`)
      const { openWindowTool } = await import('./core/tools/notification')
      const result = await openWindowTool.invoke({
        content: `
          <h2>测试报告</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><th>项目</th><th>值</th></tr>
            <tr><td>名称</td><td>测试数据</td></tr>
            <tr><td>状态</td><td>成功</td></tr>
          </table>
        `,
        title: '报告',
        popupType: 'report',
        width: 500,
        height: 400,
      })
      logger.info({ result }, '[TestPopupReport] 弹窗结果')
      socket.send(
        JSON.stringify({
          code: 200,
          type: 'command',
          data: { type: 'test_popup_report_result', ...JSON.parse(result) },
          timestamp: Date.now(),
          requestId: request.requestId,
        }) + '\n',
      )
    } else if (rawContent) {
      const { LLMResponseParser } = await import('./socket/parser')
      const parser = new LLMResponseParser(STATE_CONTEXT, request.requestId as string, socket)
      parser.debugParseAndSend(rawContent)
    }

    return ResponseBuilder.success({ sent: true }, request.requestId)
  })

  // 工具模式切换
  handler.register('tool_mode_change', createToolModeChangeHandler())

  // 取消聊天
  handler.register('chat_cancel', createChatCancelHandler())

  // 取消Buffer消息
  handler.register('buffer_cancel', createBufferCancelHandler())

  // 获取当前活跃的请求列表
  handler.register('get_active_requests', async (_data, request) => {
    const cancelManager = getChatCancelManager()
    const activeRequestIds = cancelManager.getActiveRequestIds()
    const streamingMessages = cancelManager.getAllStreamingMessages()
    return ResponseBuilder.success(
      { activeRequestIds, hasActiveRequests: activeRequestIds.length > 0, streamingMessages },
      'ok',
      request.requestId,
    )
  })

  // 终端管理 Socket handlers
  handler.register('terminal:list', async (_data, request) => {
    const sessions: { id: string; status: string }[] = []
    for (const session of terminalManager.getSessions()) {
      sessions.push({
        id: session.id,
        status: session.status,
      })
    }
    return ResponseBuilder.success({ sessions }, 'ok', request.requestId)
  })

  handler.register('terminal:create', async (data: { id?: string }, request) => {
    const sessionId = data.id || `term-${Date.now()}`
    const result = await terminalManager.createSession(sessionId)
    return ResponseBuilder.success(result, 'ok', request.requestId)
  })

  handler.register(
    'terminal:write',
    async (data: { sessionId: string; input: string }, request) => {
      terminalManager.writeInput(data.sessionId, data.input)
      return ResponseBuilder.success({ success: true }, 'ok', request.requestId)
    },
  )

  handler.register(
    'terminal:resize',
    async (data: { sessionId: string; cols: number; rows: number }, request) => {
      // terminalManager.resize(data.sessionId, data.cols, data.rows)
      return ResponseBuilder.success({ success: true }, 'ok', request.requestId)
    },
  )

  handler.register('terminal:close', async (data: { sessionId: string }, request) => {
    terminalManager.destroySession(data.sessionId)
    return ResponseBuilder.success({ success: true }, 'ok', request.requestId)
  })

  handler.register('terminal:getOutput', async (data: { sessionId: string }, request) => {
    const session = terminalManager.getSession(data.sessionId)
    if (!session) {
      return ResponseBuilder.error('Session not found', 404, request.requestId)
    }
    const output = session.getFullOutput()
    return ResponseBuilder.success({ output }, 'ok', request.requestId)
  })

  // 任务管理 Socket handlers
  handler.register('task:list', async (_data, request) => {
    try {
      const result = await taskManager.queryTasks()
      if (!result.success) {
        return ResponseBuilder.error(result.message, 500, request.requestId)
      }
      return ResponseBuilder.success(
        {
          success: true,
          message: result.message,
          tasks: result.tasks || [],
        },
        'ok',
        request.requestId,
      )
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error({ error }, '[Handlers] task:list 失败')
      return ResponseBuilder.error(`获取任务列表失败: ${err.message}`, 500, request.requestId)
    }
  })

  handler.register('task:get', async (data: { taskId: string }, request) => {
    const task = await taskManager.getTaskDetail(data.taskId)
    if (!task) {
      return ResponseBuilder.error('Task not found', 404, request.requestId)
    }
    return ResponseBuilder.success({ task }, 'ok', request.requestId)
  })

  handler.register(
    'task:updateStatus',
    async (data: { taskId: string; status: string }, request) => {
      const result = await taskManager.updateTaskStatus(data.taskId, data.status as any)
      return ResponseBuilder.success(result, 'ok', request.requestId)
    },
  )

  // 获取聊天历史
  handler.register(
    'get_chat_history',
    async (data: { limit?: number; beforeId?: string }, request) => {
      try {
        const result = await GLOBAL_MEMORY.queryMessagesWithPagination({
          limit: data.limit,
          beforeId: data.beforeId,
        })
        return ResponseBuilder.success(
          { history: result.messages, hasMore: result.hasMore },
          'ok',
          request.requestId,
        )
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        return ResponseBuilder.error(
          `Failed to get chat history: ${errorMessage}`,
          500,
          request.requestId,
        )
      }
    },
  )

  // 获取即时状态
  handler.register('get_instant_state', async (_data, request) => {
    try {
      const state = STATE_CONTEXT.getState()
      return ResponseBuilder.success(state, 'ok', request.requestId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return ResponseBuilder.error(
        `Failed to get instant state: ${errorMessage}`,
        500,
        request.requestId,
      )
    }
  })

  // 获取当前上下文Token统计
  handler.register('get_context_tokens', async (_data, request) => {
    try {
      const counter = BUFFER_WINDOW_CONTEXT.getCounter()
      const count = counter.getCount()
      return ResponseBuilder.success(count, 'ok', request.requestId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return ResponseBuilder.error(
        `Failed to get context tokens: ${errorMessage}`,
        500,
        request.requestId,
      )
    }
  })

  // 审查响应处理
  handler.register(
    'review:response',
    async (
      data: { requestId: string; approved: boolean; simulated?: boolean; reason?: string },
      request,
    ) => {
      const reviewManager = getReviewManager()
      reviewManager.handleResponse({
        requestId: data.requestId,
        approved: data.approved,
        simulated: data.simulated,
        reason: data.reason,
      })
      return ResponseBuilder.success({ success: true }, 'ok', request.requestId)
    },
  )

  // 获取审查数据
  handler.register('review:getData', async (data: { requestId: string }, request) => {
    const reviewManager = getReviewManager()
    const reviewData = reviewManager.getReviewData(data.requestId)
    return ResponseBuilder.success({ data: reviewData }, 'ok', request.requestId)
  })

  // 截图结果 - 由 screenshot.ts 工具直接监听 WebSocket 消息处理
  // 这里注册空 handler 避免 "Unknown command" 错误
  handler.register('screenshot:result', async (_data, _request) => {
    // 不返回任何内容，由 screenshot.ts 中的 socket.on('message') 监听器处理
    return null
  })

  logger.info('[Handlers] 所有Socket命令处理器已注册')
}
