import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { SocketHandler, createSocketHandler } from './handler'
import type { SocketRequest, SocketResponse } from './types'
import { ResponseBuilder, SocketResponseType } from './types'
import { logger } from '../utils/logger'
import { getTTSService } from '../tts'
import { nanoid } from 'nanoid'
import type { MemoryMessage } from '../memory'
import { STATE_CONTEXT } from '../core/state/context/impl/character-state'

/**
 * 检查端口是否被占用
 * @param port 端口号
 * @returns true 表示端口已被占用
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once('error', (_err: NodeJS.ErrnoException) => {
        // EADDRINUSE 表示端口被占用，其他错误也视为占用
        resolve(true)
      })
      .once('listening', () => {
        // 立即关闭服务器
        tester.close(() => {
          resolve(false)
        })
      })
      .listen(port, '127.0.0.1')

    // 添加超时保护，防止某些情况下事件不触发导致挂起
    setTimeout(() => {
      tester.removeAllListeners()
      try {
        tester.close()
      } catch {
        // 忽略关闭错误
      }
      resolve(true) // 超时视为端口被占用（保守策略）
    }, 3000)
  })
}

export interface HybridServerOptions {
  port: number
  host?: string
  delimiter?: string
  maxConnections?: number
}

export interface HybridServerEvents {
  onConnection?: (socket: WebSocket) => void
  onDisconnect?: (socket: WebSocket) => void
  onError?: (error: Error, socket?: WebSocket) => void
  onMessage?: (data: SocketRequest, socket: WebSocket) => void
}

export class HybridServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private wsServer: WebSocketServer | null = null
  private handler: SocketHandler
  private options: Required<HybridServerOptions>
  private events: HybridServerEvents = {}
  private connections: Set<WebSocket> = new Set()

  constructor(options: HybridServerOptions) {
    this.options = {
      host: '0.0.0.0',
      delimiter: '\n',
      maxConnections: 100,
      ...options,
    }
    this.handler = createSocketHandler()
  }

  on<K extends keyof HybridServerEvents>(
    event: K,
    callback: NonNullable<HybridServerEvents[K]>,
  ): void {
    this.events[event] = callback as never
  }

  off<K extends keyof HybridServerEvents>(event: K): void {
    delete this.events[event]
  }

  getHandler(): SocketHandler {
    return this.handler
  }

  getWSServer(): WebSocketServer | null {
    return this.wsServer
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })

      this.wsServer = new WebSocketServer({ noServer: true })

      this.httpServer.on('error', (error: Error) => {
        logger.error({ error }, 'HTTP server error')
        this.events.onError?.(error)
      })

      this.httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
        this.handleUpgrade(req, socket, head)
      })

      this.wsServer.on('connection', (socket: WebSocket, req: IncomingMessage) => {
        this.handleConnection(socket, req)
      })

      this.httpServer.listen(this.options.port, this.options.host, () => {
        logger.info({ port: this.options.port, host: this.options.host }, 'Hybrid server started')
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.httpServer) {
        resolve()
        return
      }

      for (const socket of this.connections) {
        socket.close()
      }
      this.connections.clear()

      this.wsServer?.close(() => {
        this.httpServer?.close(() => {
          this.httpServer = null
          this.wsServer = null
          logger.info('Hybrid server stopped')
          resolve()
        })
      })
    })
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = req.url?.split('?')[0] || '/'

    if (req.method === 'POST' && url === '/api/tts') {
      this.handleTTSRequest(req, res)
    } else if (req.method === 'POST' && url === '/api/tts/stream') {
      this.handleStreamingTTSRequest(req, res)
    } else if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }))
    } else if (req.method === 'POST' && url === '/api/chat') {
      this.handleChatPostRequest(req, res)
    } else if (req.method === 'POST' && url === '/api/review/response') {
      this.handleReviewResponse(req, res)
    } else if (req.method === 'GET' && url === '/api/settings') {
      this.handleSettingsGetConfig(req, res)
    } else if (req.method === 'POST' && url === '/api/settings/whitelist') {
      this.handleSettingsSaveWhitelist(req, res)
    } else if (req.method === 'POST' && url === '/api/settings/truncation') {
      this.handleSettingsSaveTruncation(req, res)
    } else if (req.method === 'GET' && url === '/api/mcp/servers') {
      this.handleMCPGetServers(req, res)
    } else if (req.method === 'POST' && url === '/api/mcp/refresh') {
      this.handleMCPRefresh(req, res)
    } else if (req.method === 'POST' && url === '/api/mcp/refresh-all') {
      this.handleMCPRefreshAll(req, res)
    } else if (req.method === 'GET' && url === '/api/mcp/tools') {
      this.handleMCPGetTools(req, res)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found', code: 404 }))
    }
  }

  private handleChatPostRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        const message = data.message

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Message parameter is required', code: 400 }))
          return
        }

        const requestId = `http-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
        logger.info(`[HTTP Chat]收到消息: <${requestId}> ${message.substring(0, 50)}`)

        const socket = Array.from(this.connections)[0]
        if (!socket || socket.readyState !== 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'No WebSocket connection available', code: 503 }))
          return
        }

        socket.send(
          JSON.stringify({
            code: 200,
            type: 'REQUEST_START',
            data: { requestId },
            timestamp: Date.now(),
            requestId,
          }) + '\n',
        )

        socket.send(
          JSON.stringify({
            code: 200,
            type: SocketResponseType.MESSAGE_STREAM,
            data: {
              id: `human-${nanoid(8)}`,
              type: 'human',
              content: message,
              timestamp: Date.now(),
            } as MemoryMessage,
            timestamp: Date.now(),
            requestId,
          }) + '\n',
        )

        void this.sendChatMessage(message, requestId, socket)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 200, requestId, message: 'Message sent' }))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Invalid request: ${errorMessage}`, code: 400 }))
      }
    })
  }

  private async sendChatMessage(
    message: string,
    requestId: string,
    socket: WebSocket,
  ): Promise<void> {
    try {
      const { createAgent } = await import('../core/graph')
      const { HumanMessage } = await import('@langchain/core/messages')
      const { LLMResponseParser } = await import('../socket/parser')
      const { getChatCancelManager } = await import('../core/state/chat-cancel')

      const cancelManager = getChatCancelManager()
      cancelManager.registerChat(requestId)

      const graph = await createAgent()
      const parser = new LLMResponseParser(STATE_CONTEXT, requestId, socket)

      const stream = await graph.stream(
        { messages: [new HumanMessage(message)], requestId },
        { configurable: { thread_id: 'main' }, streamMode: 'updates', recursionLimit: 100 },
      )

      for await (const chunk of stream) {
        await parser.parseChunk(chunk)
      }

      logger.info(`[HTTP Chat]消息处理完成 <${requestId}>`)
    } catch (error) {
      logger.error({ error }, `[HTTP Chat]消息处理失败 <${requestId}>`)
    } finally {
      socket.send(
        JSON.stringify({
          code: 200,
          type: 'REQUEST_COMPLETE',
          data: { requestId },
          timestamp: Date.now(),
          requestId,
        }) + '\n',
      )
    }
  }

  /**
   * 处理审查响应
   */
  private handleReviewResponse(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const data = JSON.parse(body)
        const { requestId, approved, simulated, reason } = data

        if (!requestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'requestId is required', code: 400 }))
          return
        }

        // 调用 review-manager 处理响应
        const { getReviewManager } = await import('../core/review')
        const reviewManager = getReviewManager()
        reviewManager.handleResponse({ requestId, approved, simulated, reason })

        logger.info({ requestId, approved, simulated }, '[HTTP Review] 审查响应已处理')

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 200, message: 'Review response processed' }))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error({ error }, '[HTTP Review] 处理审查响应失败')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: `Failed to process review response: ${errorMessage}`,
            code: 500,
          }),
        )
      }
    })
  }

  /**
   * 读取请求体的辅助方法
   */
  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  /**
   * 获取配置中心完整配置
   */
  private async handleSettingsGetConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const { settingManager } = await import('../config/setting-manager')
      const config = settingManager.getConfig()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200, data: config }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP Settings] 获取配置失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg }))
    }
  }

  /**
   * 保存工具审查白名单
   */
  private async handleSettingsSaveWhitelist(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readRequestBody(req)
      const { whitelist } = JSON.parse(body)
      const { settingManager } = await import('../config/setting-manager')
      const success = settingManager.setToolReviewWhitelist(whitelist)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: success ? 200 : 500, success }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP Settings] 保存白名单失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg, success: false }))
    }
  }

  /**
   * 保存工具截断配置
   */
  private async handleSettingsSaveTruncation(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readRequestBody(req)
      const config = JSON.parse(body)
      const { settingManager } = await import('../config/setting-manager')
      const success = settingManager.setToolTruncationConfig(config)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: success ? 200 : 500, success }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP Settings] 保存截断配置失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg, success: false }))
    }
  }

  /**
   * 获取 MCP 服务器列表
   */
  private async handleMCPGetServers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const { getMCPServers } = await import('../core/tools/mcp/config')
      const servers = getMCPServers()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200, data: servers }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP MCP] 获取服务器列表失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg, data: [] }))
    }
  }

  /**
   * 刷新单个 MCP 服务器缓存
   */
  private async handleMCPRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readRequestBody(req)
      const { serverName } = JSON.parse(body)
      const { mcpToolCacheManager } = await import('../core/tools/mcp/mcp-cache')
      const result = await mcpToolCacheManager.refreshCache(serverName)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: result.success ? 200 : 500, ...result }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP MCP] 刷新服务器失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg, success: false }))
    }
  }

  /**
   * 刷新所有 MCP 服务器缓存
   */
  private async handleMCPRefreshAll(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const { mcpToolCacheManager } = await import('../core/tools/mcp/mcp-cache')
      const results = await mcpToolCacheManager.refreshAllCache()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200, success: true, data: results }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP MCP] 刷新所有服务器失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg, success: false, data: [] }))
    }
  }

  /**
   * 获取 MCP 工具列表
   */
  private async handleMCPGetTools(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const { mcpToolManager } = await import('../core/tools/mcp/adapter')
      const tools = await mcpToolManager.getTools()
      const toolList = tools.map((tool) => tool.name)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200, success: true, data: toolList }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error }, '[HTTP MCP] 获取工具列表失败')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 500, error: msg, success: false, data: [] }))
    }
  }

  private handleTTSRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const data = JSON.parse(body)
        const { text, speed = 'stand', batchId, batchIndex, isBatchComplete } = data

        if (!text || typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Text is required', code: 400 }))
          return
        }

        const batchContext =
          batchId && batchIndex !== undefined
            ? { batchId, batchIndex, isBatchComplete: isBatchComplete ?? false }
            : undefined

        const ttsService = getTTSService()
        logger.debug({ batchContext }, '[TTS] Calling synthesize...')
        const result = await ttsService.synthesize(text, speed, undefined, batchContext)
        logger.debug({ duration: result.duration }, '[TTS] Synthesize complete')

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 200,
            message: 'TTS synthesized',
            data: {
              audioBase64: result.audioBuffer.toString('base64'),
              duration: result.duration,
            },
          }),
        )
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(
          { errorMessage, stack: error instanceof Error ? error.stack : undefined },
          'TTS request failed',
        )
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `TTS failed: ${errorMessage}`, code: 500 }))
      }
    })

    req.on('error', (error: Error) => {
      logger.error({ error }, 'Request error')
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request error', code: 500 }))
    })
  }

  private handleStreamingTTSRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const data = JSON.parse(body)
        const { text, speed = 'stand' } = data

        if (!text || typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Text is required', code: 400 }))
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })

        const ttsService = getTTSService()
        let chunkIndex = 0

        await ttsService.synthesize(text, speed, {
          meta: () => {},
          audio: (audioChunk: Buffer) => {
            chunkIndex++
            const message = `data: ${JSON.stringify({
              type: 'audio',
              index: chunkIndex,
              audioBase64: audioChunk.toString('base64'),
            })}\n\n`
            res.write(message)
          },
        })

        res.write(`data: ${JSON.stringify({ type: 'done', chunks: chunkIndex })}\n\n`)
        res.end()
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        logger.error({ error }, 'Streaming TTS request failed')
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `TTS failed: ${errorMessage}`, code: 500 }))
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', message: errorMessage })}\n\n`)
          res.end()
        }
      }
    })

    req.on('error', (error: Error) => {
      logger.error({ error }, 'Request error')
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request error', code: 500 }))
      }
    })
  }

  private handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    logger.info({ url: req.url }, 'WebSocket upgrade request received')

    this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
      this.wsServer!.emit('connection', ws, req)
    })
  }

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    if (this.connections.size >= this.options.maxConnections) {
      const response = ResponseBuilder.error('Max connections reached', 503)
      socket.send(JSON.stringify(response) + this.options.delimiter)
      socket.close()
      return
    }

    this.connections.add(socket)
    this.events.onConnection?.(socket)

    logger.info(
      { connections: this.connections.size, ip: req.socket.remoteAddress },
      'WebSocket client connected',
    )

    let buffer = ''

    socket.on('message', async (data: Buffer) => {
      buffer += data.toString()

      const messages = buffer.split(this.options.delimiter)
      buffer = messages.pop() || ''

      for (const message of messages) {
        if (message.trim()) {
          await this.processMessage(message.trim(), socket)
        }
      }
    })

    socket.on('close', () => {
      this.connections.delete(socket)
      this.events.onDisconnect?.(socket)
      logger.info({ connections: this.connections.size }, 'WebSocket client disconnected')
    })

    socket.on('error', (error: Error) => {
      logger.error({ error }, 'Socket connection error')
      this.events.onError?.(error, socket)
    })
  }

  private async processMessage(message: string, socket: WebSocket): Promise<void> {
    let request: SocketRequest

    try {
      request = JSON.parse(message) as SocketRequest
    } catch {
      const response = ResponseBuilder.error('Invalid JSON format', 400)
      this.sendResponse(socket, response)
      return
    }

    if (!request.command) {
      const response = ResponseBuilder.error('Missing command field', 400, request.requestId)
      this.sendResponse(socket, response)
      return
    }

    this.events.onMessage?.(request, socket)

    try {
      const response = await this.handler.handle(request, socket)
      if (response) {
        this.sendResponse(socket, response)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const response = ResponseBuilder.error(errorMessage, 500, request.requestId)
      this.sendResponse(socket, response)
    }
  }

  private sendResponse<T>(socket: WebSocket, response: SocketResponse<T>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response) + this.options.delimiter)
    }
  }

  broadcast<T>(response: SocketResponse<T>): void {
    const message = JSON.stringify(response) + this.options.delimiter
    for (const socket of this.connections) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message)
      }
    }
  }

  getActiveConnections(): number {
    return this.connections.size
  }

  getConnections(): Set<WebSocket> {
    return this.connections
  }

  isRunning(): boolean {
    return this.httpServer !== null
  }
}

export function createHybridServer(options: HybridServerOptions): HybridServer {
  instance = new HybridServer(options)
  return instance
}

let instance: HybridServer | null = null

export function getHybridServer(): HybridServer | null {
  return instance
}
