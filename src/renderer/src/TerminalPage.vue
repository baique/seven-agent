<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from 'xterm'
import { WebLinksAddon } from 'xterm-addon-web-links'
import 'xterm/css/xterm.css'
import { createSocketClient, SocketClient } from './socket'
import type { SocketResponse } from './socket/types'

interface Session {
  id: string
  status: 'idle' | 'running' | 'done'
}

interface TerminalListResponse {
  sessions: { id: string; status: string }[]
}

/** 终端固定行列数配置，与后台 TerminalSession 保持一致 */
const TERMINAL_COLS = 80
const TERMINAL_ROWS = 30

const sessions = ref<Session[]>([])
const activeSessionId = ref<string | null>(null)
const termContainers = ref<Record<string, HTMLElement>>({})
const terminals = ref<Record<string, Terminal>>({})

let socketClient: SocketClient | null = null
let httpPort = 9172

async function connectSocket() {
  const info = await window.electron.ipcRenderer.invoke('getInfo')
  httpPort = info.socketPort

  socketClient = createSocketClient({ host: 'localhost', port: httpPort })
  await socketClient.connect()

  const handler = socketClient.getHandler()

  handler.register(
    'terminal:output',
    (res: SocketResponse<{ sessionId: string; data: string }>) => {
      if (res.data) {
        const term = terminals.value[res.data.sessionId]
        if (term) {
          term.write(res.data.data)
        }
      }
    },
  )

  handler.register(
    'terminal:session_created',
    async (res: SocketResponse<{ sessionId: string }>) => {
      if (res.data && !sessions.value.find((s) => s.id === res.data!.sessionId)) {
        sessions.value.push({ id: res.data!.sessionId, status: 'idle' })
        await nextTick()
        await nextTick()
        initTerminal(res.data!.sessionId)
      }
    },
  )

  handler.register('terminal:session_closed', (res: SocketResponse<{ sessionId: string }>) => {
    if (res.data) {
      const id = res.data.sessionId
      if (terminals.value[id]) {
        terminals.value[id].dispose()
        delete terminals.value[id]
        delete termContainers.value[id]
      }
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeSessionId.value === id) {
        activeSessionId.value = sessions.value[0]?.id || null
      }
    }
  })

  handler.register(
    'terminal:status_changed',
    (res: SocketResponse<{ sessionId: string; status: string }>) => {
      if (res.data) {
        const session = sessions.value.find((s) => s.id === res.data!.sessionId)
        if (session) {
          session.status = res.data.status as 'idle' | 'running' | 'done'
        }
      }
    },
  )
}

async function loadSessions() {
  if (!socketClient) return

  const response = await sendCommand<TerminalListResponse>('terminal:list', {})
  if (response.sessions) {
    for (const session of response.sessions) {
      if (!sessions.value.find((s) => s.id === session.id)) {
        sessions.value.push({
          id: session.id,
          status: session.status as 'idle' | 'running' | 'done',
        })
      }
    }
    sessions.value = sessions.value.filter((s) => response.sessions.some((ns) => ns.id === s.id))
    if (sessions.value.length > 0 && !activeSessionId.value) {
      activeSessionId.value = sessions.value[0].id
      await nextTick()
      await nextTick()
      initTerminal(sessions.value[0].id)
    }
  }
}

function initTerminal(sessionId: string) {
  const container = termContainers.value[sessionId]
  if (!container || terminals.value[sessionId]) return

  const term = new Terminal({
    theme: {
      background: 'rgba(0, 0, 0, 0.3)',
      foreground: '#00ff88',
      cursor: '#00ff88',
      cursorAccent: 'rgba(0, 0, 0, 0.3)',
      selectionBackground: '#00ff8833',
      black: '#000000',
      red: '#ff4444',
      green: '#00ff88',
      yellow: '#ffff00',
      blue: '#4444ff',
      magenta: '#ff00ff',
      cyan: '#00ff88',
      white: '#ffffff',
      brightBlack: '#444444',
      brightRed: '#ff6666',
      brightGreen: '#00ff88',
      brightYellow: '#ffff88',
      brightBlue: '#6666ff',
      brightMagenta: '#ff66ff',
      brightCyan: '#66ffff',
      brightWhite: '#ffffff',
    },
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    rows: TERMINAL_ROWS,
    cols: TERMINAL_COLS,
  })

  const webLinksAddon = new WebLinksAddon()
  term.loadAddon(webLinksAddon)

  term.open(container)

  const geometry = term.proposeGeometry?.() ?? { width: 80 * 9, height: 30 * 20 }
  container.style.width = `${geometry.width}px`
  container.style.height = `${geometry.height}px`

  setTimeout(() => {
    if (socketClient && sessionId) {
      socketClient.send({
        command: 'terminal:resize',
        data: { sessionId, cols: TERMINAL_COLS, rows: TERMINAL_ROWS },
        requestId: `term-resize-${Date.now()}`,
      })
    }

    sendCommand<{ output: string }>('terminal:getOutput', { sessionId })
      .then((res) => {
        if (res.output) {
          term.write(res.output)
        }
      })
      .catch(() => {})
  }, 100)

  terminals.value[sessionId] = term

  term.onData((data) => {
    if (socketClient && sessionId) {
      socketClient.send({
        command: 'terminal:write',
        data: { sessionId, input: data },
        requestId: `term-write-${Date.now()}`,
      })
    }
  })
}

async function createNewSession() {
  const response = await sendCommand<{ sessionId: string }>('terminal:create', {})
  if (response.sessionId) {
    if (!sessions.value.find((s) => s.id === response.sessionId)) {
      sessions.value.push({ id: response.sessionId, status: 'idle' })
    }
    activeSessionId.value = response.sessionId
    await nextTick()
    await nextTick()
    initTerminal(response.sessionId)
    terminals.value[response.sessionId]?.focus()
  }
}

async function closeSession(id: string) {
  await sendCommand('terminal:close', { sessionId: id })
}

async function switchSession(id: string) {
  activeSessionId.value = id
  await nextTick()
  await nextTick()

  if (!terminals.value[id]) {
    initTerminal(id)
  }

  terminals.value[id]?.focus()
}

function clearTerminal() {
  if (activeSessionId.value) {
    const term = terminals.value[activeSessionId.value]
    if (term) {
      term.reset()
    }
  }
}

function closeWindow() {
  window.close()
}

function sendCommand<T = unknown>(command: string, data: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socketClient) {
      reject(new Error('Socket not connected'))
      return
    }
    const requestId = `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const handler = socketClient.getHandler()
    handler.register(`req:${requestId}`, (res: SocketResponse<T>) => {
      if (res.code === 200 && res.data) {
        resolve(res.data)
      } else {
        reject(new Error(res.message || 'Command failed'))
      }
    })
    socketClient.send({ command, data, requestId })
  })
}

onMounted(async () => {
  await connectSocket()
  await loadSessions()
})

onUnmounted(() => {
  socketClient?.disconnect()
  for (const term of Object.values(terminals.value)) {
    term.dispose()
  }
})
</script>

<template>
  <div class="terminal-panel">
    <div class="corner-decor tl"></div>
    <div class="corner-decor tr"></div>
    <div class="corner-decor bl"></div>
    <div class="corner-decor br"></div>

    <div class="panel-header">
      <span class="header-title">终端管理</span>
      <div class="header-actions">
        <button class="action-btn" @click="createNewSession">+ 新建</button>
        <button class="action-btn close-btn" @click="closeWindow">关闭</button>
      </div>
    </div>

    <div class="panel-body">
      <div class="sidebar">
        <div class="sidebar-title">会话</div>
        <div class="session-list">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="session-item"
            :class="{ active: session.id === activeSessionId }"
            @click="switchSession(session.id)"
          >
            <span class="session-name">{{ session.id }}</span>
            <span class="session-status" :class="session.status">{{ session.status }}</span>
            <button class="session-close" @click.stop="closeSession(session.id)">×</button>
          </div>
          <div v-if="sessions.length === 0" class="no-session">暂无会话</div>
        </div>
      </div>

      <div class="terminal-area">
        <div class="terminal-header">
          <span>{{ activeSessionId || '未选择会话' }}</span>
          <button class="clear-btn" @click="clearTerminal">清屏</button>
        </div>
        <div class="terminal-content">
          <div
            v-for="session in sessions"
            :key="session.id"
            :ref="(el) => (termContainers[session.id] = el as HTMLElement)"
            class="terminal-instance"
            :style="{ display: session.id === activeSessionId ? 'block' : 'none' }"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #0a1a12 0%, #0d2218 50%, #081510 100%);
  border: 1px solid rgba(0, 255, 136, 0.5);
  border-radius: 8px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.6),
    0 0 60px rgba(0, 255, 136, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 0 80px rgba(0, 255, 136, 0.05);
  overflow: hidden;
}

.corner-decor {
  position: absolute;
  width: 16px;
  height: 16px;
  border-color: #00ff88;
  border-style: solid;
  opacity: 0.8;
  z-index: 10;
}

.corner-decor.tl {
  top: 4px;
  left: 4px;
  border-width: 2px 0 0 2px;
  border-top-left-radius: 4px;
}

.corner-decor.tr {
  top: 4px;
  right: 4px;
  border-width: 2px 2px 0 0;
  border-top-right-radius: 4px;
}

.corner-decor.bl {
  bottom: 4px;
  left: 4px;
  border-width: 0 0 2px 2px;
  border-bottom-left-radius: 4px;
}

.corner-decor.br {
  bottom: 4px;
  right: 4px;
  border-width: 0 2px 2px 0;
  border-bottom-right-radius: 4px;
}

.corner-decor::before {
  content: '';
  position: absolute;
  width: 4px;
  height: 4px;
  background: #00ff88;
  border-radius: 50%;
  box-shadow:
    0 0 6px #00ff88,
    0 0 12px #00ff88;
}

.corner-decor.tl::before {
  top: -1px;
  left: -1px;
}

.corner-decor.tr::before {
  top: -1px;
  right: -1px;
}

.corner-decor.bl::before {
  bottom: -1px;
  left: -1px;
}

.corner-decor.br::before {
  bottom: -1px;
  right: -1px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: linear-gradient(180deg, rgba(0, 255, 136, 0.1) 0%, transparent 100%);
  border-bottom: 1px solid rgba(0, 255, 136, 0.3);
  position: relative;
  z-index: 5;
  -webkit-app-region: drag;
}

.panel-header button {
  -webkit-app-region: no-drag;
}

.header-title {
  font-size: 14px;
  font-weight: 500;
  color: #00ff88;
  text-shadow: 0 0 15px rgba(0, 255, 136, 0.6);
  letter-spacing: 1px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  background: rgba(0, 255, 136, 0.1);
  border: 1px solid rgba(0, 255, 136, 0.4);
  color: #00ff88;
  padding: 4px 12px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  border-radius: 4px;
  transition: all 0.2s;
}

.action-btn:hover {
  background: rgba(0, 255, 136, 0.2);
  box-shadow: 0 0 10px rgba(0, 255, 136, 0.3);
}

.close-btn {
  background: rgba(255, 68, 68, 0.15);
  border-color: rgba(255, 68, 68, 0.4);
  color: #ff6666;
}

.close-btn:hover {
  background: rgba(255, 68, 68, 0.25);
  box-shadow: 0 0 10px rgba(255, 68, 68, 0.3);
}

.panel-body {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
  z-index: 5;
}

.sidebar {
  width: 160px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(0, 255, 136, 0.2);
  background: rgba(0, 0, 0, 0.3);
}

.sidebar-title {
  padding: 10px 12px;
  font-size: 10px;
  color: rgba(0, 255, 136, 0.7);
  text-transform: uppercase;
  letter-spacing: 1px;
  border-bottom: 1px solid rgba(0, 255, 136, 0.15);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.session-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 4px;
  margin-bottom: 3px;
  transition: all 0.15s;
  gap: 6px;
  border: 1px solid transparent;
}

.session-item:hover {
  background: rgba(0, 255, 136, 0.08);
  border-color: rgba(0, 255, 136, 0.2);
}

.session-item.active {
  background: rgba(0, 255, 136, 0.12);
  border-color: rgba(0, 255, 136, 0.4);
  box-shadow: 0 0 10px rgba(0, 255, 136, 0.15);
}

.session-name {
  flex: 1;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-status {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 6px;
  text-transform: uppercase;
}

.session-status.idle {
  background: rgba(100, 100, 100, 0.25);
  color: rgba(255, 255, 255, 0.5);
}

.session-status.running {
  background: rgba(0, 255, 136, 0.15);
  color: #00ff88;
}

.session-status.done {
  background: rgba(0, 255, 136, 0.15);
  color: #00ff88;
}

.session-close {
  background: transparent;
  border: none;
  color: rgba(255, 68, 68, 0.6);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-close {
  opacity: 1;
}

.session-close:hover {
  color: #ff4444;
}

.no-session {
  padding: 20px 10px;
  text-align: center;
  color: rgba(255, 255, 255, 0.3);
  font-size: 11px;
}

.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(0, 255, 136, 0.05);
  border-bottom: 1px solid rgba(0, 255, 136, 0.15);
  font-size: 11px;
  color: rgba(0, 255, 136, 0.7);
}

.clear-btn {
  background: rgba(0, 255, 136, 0.1);
  border: 1px solid rgba(0, 255, 136, 0.3);
  color: #00ff88;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 9px;
  border-radius: 3px;
}

.clear-btn:hover {
  background: rgba(0, 255, 136, 0.2);
}

.terminal-content {
  padding: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.terminal-instance {
  background: rgba(0, 0, 0, 0.4);
  border-radius: 4px;
  overflow: hidden;
  display: inline-block;
  flex: 0 0 auto;
}

.session-list::-webkit-scrollbar {
  width: 4px;
}

.session-list::-webkit-scrollbar-track {
  background: transparent;
}

.session-list::-webkit-scrollbar-thumb {
  background: rgba(0, 255, 136, 0.25);
  border-radius: 2px;
}
</style>

<style>
/* 终端区域滚动条 - 赛博朋克风格 */
.terminal-content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.terminal-content::-webkit-scrollbar-track {
  background: rgba(0, 20, 10, 0.3);
  border-radius: 3px;
}

.terminal-content::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(0, 255, 136, 0.4) 0%, rgba(0, 200, 100, 0.3) 100%);
  border-radius: 3px;
  border: 1px solid rgba(0, 255, 136, 0.2);
  box-shadow: 0 0 6px rgba(0, 255, 136, 0.2);
}

.terminal-content::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(0, 255, 136, 0.6) 0%, rgba(0, 220, 120, 0.5) 100%);
  box-shadow: 0 0 10px rgba(0, 255, 136, 0.4);
}

.terminal-content::-webkit-scrollbar-corner {
  background: rgba(0, 20, 10, 0.3);
}

/* xterm 内部滚动条 */
.terminal-instance .xterm-viewport::-webkit-scrollbar {
  width: 6px;
}

.terminal-instance .xterm-viewport::-webkit-scrollbar-track {
  background: rgba(0, 20, 10, 0.3);
  border-radius: 3px;
}

.terminal-instance .xterm-viewport::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(0, 255, 136, 0.4) 0%, rgba(0, 200, 100, 0.3) 100%);
  border-radius: 3px;
  border: 1px solid rgba(0, 255, 136, 0.2);
  box-shadow: 0 0 6px rgba(0, 255, 136, 0.2);
}

.terminal-instance .xterm-viewport::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(0, 255, 136, 0.6) 0%, rgba(0, 220, 120, 0.5) 100%);
  box-shadow: 0 0 10px rgba(0, 255, 136, 0.4);
}
</style>
