<script setup lang="ts">
import { onMounted, ref, nextTick, onUnmounted, computed, provide } from 'vue'
import {
  SendOutlined,
  LoadingOutlined,
  PushpinOutlined,
  ReloadOutlined,
  AudioOutlined,
  SafetyOutlined,
  ThunderboltOutlined,
  StopOutlined,
} from '@ant-design/icons-vue'
import { eventBus, Events } from './eventBus'
import { useSocket } from './composables/useSocket'
import { useMessageStore } from './composables/useMessageStore'
import { useAudioPlayer } from './composables/useAudioPlayer'
import { useCharacterAction } from './composables/useCharacterAction'
import { useModelStateSync } from './composables/useModelStateSync'
import { throttle } from 'lodash-es'
import { useEmotionDecay } from './composables/useEmotionDecay'
import { useToolMode } from './composables/useToolMode'
import Live2DViewer from './components/Live2DViewer.vue'
import PersonalityPanel from './components/PersonalityPanel.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import TaskPanel from './components/TaskPanel.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import type { StateCommand } from './composables/useCharacterAction'
import './assets/chat.css'
import { storeToRefs } from 'pinia'
import { bindToggleMouseEvent, initWatchMouse } from './util'

defineOptions({ name: 'ChatApp' })

const {
  client,
  connect,
  send,
  sendTTS,
  sendModelState,
  cancelChat,
  getChatHistory,
  getInstantState,
  getModelConfig,
  setWindowTop,
  getWindowState,
  setIgnoreMouse,
} = useSocket()
const messageStore = useMessageStore()
const { loading, cancelled, bufferMessage } = storeToRefs(messageStore)!
const { cancelBufferMessage } = useSocket()

const audioPlayer = useAudioPlayer()
const { audioPlaying, audioQueueLength } = audioPlayer
const isMicActive = ref(true)

const characterAction = useCharacterAction({
  shouldProcessCommand: () => isMicActive.value,
})
const { clearActionQueue } = characterAction
const toolMode = useToolMode()
useModelStateSync(sendModelState)

const chatVisible = ref(false)
const isPinned = ref(false)
const miniInputValue = ref('')

/** /cmd 自动补全相关 */
const CMD_SUGGESTIONS = [
  { cmd: '/compress', desc: '极限压缩' },
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/say ', desc: '模拟消息' },
]
const showCmdAutocomplete = ref(false)
const selectedSuggestionIndex = ref(0)
const cmdSuggestions = computed(() => {
  const input = miniInputValue.value.trim()
  if (!input.startsWith('/')) return []
  return CMD_SUGGESTIONS.filter((s) => s.cmd.startsWith(input))
})
const live2dModelUrl = ref('')
const live2dDefaultParams = ref<{ id: string; value: number }[]>([])
const live2dIdleBehaviorsPath = ref<string | null>(null)
const miniSenderRef = ref<HTMLElement | null>(null)
const live2dViewerRef = ref<InstanceType<typeof Live2DViewer>>()
const modelLoaded = ref(false)
const modelPosition = ref({ x: 0, y: 0, width: 0, height: 0 })

// 面板 refs
const taskPanelRef = ref<{
  resetToFollow: () => void
  mode?: 'follow' | 'independent'
} | null>(null)
const historyPanelRef = ref<{
  resetToFollow: () => void
  mode?: 'follow' | 'independent'
} | null>(null)
const terminalPanelRef = ref<{
  resetToFollow: () => void
  mode?: 'follow' | 'independent'
} | null>(null)
const personalityPanelRef = ref<{
  resetToFollow: () => void
  mode?: 'follow' | 'independent'
} | null>(null)

/** 人物和跟随面板是否隐藏 */
const isCharacterHidden = ref(false)
const socketReady = ref(false)

/** 检查面板是否应该显示（独立模式的面板在隐藏时仍显示） */
const isPanelVisible = (panelRef: { mode?: 'follow' | 'independent' } | null): boolean => {
  if (!isCharacterHidden.value) return true
  return panelRef?.mode === 'independent'
}
/** 当前对话请求ID，用于取消功能 */
const currentRequestId = ref<string | null>(null)

const instantStateData = ref({
  bigFive: {
    extraversion: 0.5,
    agreeableness: 0.5,
    openness: 0.5,
    conscientiousness: 0.5,
    neuroticism: 0.5,
  },
  pad: {
    pleasure: 0.5,
    arousal: 0.5,
    dominance: 0.5,
  },
  moodDescription: '平静',
  activity: '待机',
})

const tokenStats = ref<{
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  elapsedMs: number
} | null>(null)

const TOKEN_STATS_KEY = 'llm_token_stats'

const loadTokenStats = () => {
  try {
    const saved = localStorage.getItem(TOKEN_STATS_KEY)
    if (saved) {
      tokenStats.value = JSON.parse(saved)
    }
  } catch (e) {
    console.error('[App] 加载token统计失败:', e)
  }
}

const saveTokenStats = () => {
  if (tokenStats.value) {
    localStorage.setItem(TOKEN_STATS_KEY, JSON.stringify(tokenStats.value))
  }
}

/** 向子面板提供人物位置（响应式） */
provide('modelPosition', modelPosition)
/** 向子面板提供全局隐藏状态 */
provide('isCharacterHidden', isCharacterHidden)

const wrapperStyle = computed(() => {
  const pos = modelPosition.value
  if (pos.width === 0) return { left: '0px', top: '0px', display: 'none' }

  const headY = pos.y - pos.height / 2 - 60

  return {
    left: pos.x + 'px',
    top: headY + 'px',
    transform: 'translateX(-50%) translateY(-100%)',
  }
})

/** 人物是否在屏幕右侧 */
const isModelOnRightSide = computed(() => modelPosition.value.x > window.innerWidth / 2)

const setModelParameter = (paramId: string, value: number | string) => {
  live2dViewerRef.value?.setParameter(paramId, value)
}

const clearModelParameter = (paramId: string) => {
  live2dViewerRef.value?.clearParameter(paramId)
}

useEmotionDecay(setModelParameter, clearModelParameter)

const unsubscribers: (() => void)[] = []

unsubscribers.push(
  eventBus.on(Events.FACE_START, (face: StateCommand) => {
    live2dViewerRef.value?.animateParams(face.params)
  }),
)

unsubscribers.push(
  eventBus.on(Events.FACE_END, (face: StateCommand) => {
    live2dViewerRef.value?.animateAndClearParams(face.params)
  }),
)

unsubscribers.push(
  eventBus.on(Events.ACT_START, (act: StateCommand) => {
    live2dViewerRef.value?.animateParams(act.params)
  }),
)

unsubscribers.push(
  eventBus.on(Events.ACT_END, (act: StateCommand) => {
    for (const p of act.params) {
      live2dViewerRef.value?.clearParameter(p.name)
    }
  }),
)

unsubscribers.push(
  eventBus.on(Events.REQUEST_START, (data: { requestId: string }) => {
    currentRequestId.value = data.requestId
  }),
)

unsubscribers.push(
  eventBus.on(Events.REQUEST_COMPLETE, () => {
    currentRequestId.value = null
  }),
)

/**
 * 从地址栏获取端口，支持通过 ?port=xxx 覆盖
 */
const getPortFromUrl = (): number => {
  const urlParams = new URLSearchParams(window.location.search)
  const portParam = urlParams.get('port')
  if (portParam) {
    const port = parseInt(portParam, 10)
    if (!isNaN(port)) return port
  }
  // 默认端口
  return 9172
}

onMounted(async () => {
  // 监听人格更新事件
  eventBus.on(Events.PERSONALITY_UPDATED, (data: any) => {
    instantStateData.value = {
      bigFive: data?.bigFive,
      pad: data?.pad,
      moodDescription: data?.moodDescription,
      activity: data?.activity,
    }
  })

  // 监听窗口状态变更
  eventBus.on(Events.WINDOW_STATE_CHANGE, (data: { alwaysOnTop: boolean }) => {
    isPinned.value = data.alwaysOnTop
  })

  // 监听重置位置事件
  eventBus.on('position_reset', () => {
    live2dViewerRef.value?.resetView()
    // 重置所有面板到跟随模式
    taskPanelRef.value?.resetToFollow()
    historyPanelRef.value?.resetToFollow()
    terminalPanelRef.value?.resetToFollow()
    personalityPanelRef.value?.resetToFollow()
  })

  // 监听人物和跟随面板显示/隐藏事件
  eventBus.on('toggle_character_visibility', (data: { hidden: boolean }) => {
    isCharacterHidden.value = data.hidden
  })

  eventBus.on('focus_input', () => {
    const textarea = miniTextareaRef.value as HTMLTextAreaElement
    if (textarea) {
      textarea.focus()
    }
  })

  // 注册主进程IPC事件监听（快捷键触发）
  if (window.api?.on) {
    // 窗口状态变更（Ctrl+7 双击）
    window.api.on('window-state-changed', (data: { alwaysOnTop: boolean }) => {
      isPinned.value = data.alwaysOnTop
    })

    // 显示/隐藏人物和跟随面板（Ctrl+7 / Ctrl+Shift+7）
    window.api.on('toggle-character-visibility', (data: { hidden: boolean }) => {
      isCharacterHidden.value = data.hidden
    })

    // 聚焦输入框（Ctrl+7）
    window.api.on('focus-input', () => {
      const textarea = miniTextareaRef.value as HTMLTextAreaElement
      if (textarea) {
        textarea.focus()
      }
    })

    // 重置位置（托盘菜单）
    window.api.on('position-reset', () => {
      live2dViewerRef.value?.resetView()
      taskPanelRef.value?.resetToFollow()
      historyPanelRef.value?.resetToFollow()
      terminalPanelRef.value?.resetToFollow()
      personalityPanelRef.value?.resetToFollow()
    })
  }

  eventBus.on(Events.TOKEN_USAGE, (data: any) => {
    tokenStats.value = data
    saveTokenStats()
  })

  audioPlayer.setMouthCallback((openness: number) => {
    live2dViewerRef.value?.setMouthOpenness(openness)
  })

  // Socket连接就绪后加载初始数据
  eventBus.on(Events.SOCKET_READY, async () => {
    socketReady.value = true
    loadTokenStats()

    try {
      const modelConfig = await getModelConfig()
      live2dModelUrl.value = modelConfig.modelUrl
      live2dDefaultParams.value = modelConfig.defaultParams
      live2dIdleBehaviorsPath.value = modelConfig.idleBehaviorsPath
    } catch (e) {
      console.error('[App] 获取模型配置失败:', e)
    }

    toolMode.init(client.value!)

    characterAction.setTTSSynthesize((text, speed, batchContext) => {
      return sendTTS(text, speed, batchContext)
    })

    try {
      const { alwaysOnTop } = await getWindowState()
      isPinned.value = alwaysOnTop
    } catch (e) {
      console.error('[App] 获取窗口状态失败:', e)
    }

    try {
      const state = await getInstantState()
      instantStateData.value = {
        bigFive: state.bigFive,
        pad: state.pad,
        moodDescription: state.moodDescription,
        activity: state.activity,
      }
    } catch (e) {
      console.error('[App] 获取即时状态失败:', e)
    }
  })

  const socketPort = getPortFromUrl()

  await connect(socketPort)

  // 阻断点击
  await setIgnoreMouse(true, { forward: true })

  nextTick(() => {
    if (miniSenderRef.value) bindToggleMouseEvent(miniSenderRef.value)
  })
  initWatchMouse()
})

onUnmounted(() => {
  unsubscribers.forEach((unsub) => unsub())
})

const togglePin = async () => {
  try {
    isPinned.value = !isPinned.value
    await setWindowTop(isPinned.value)
  } catch (e) {
    console.error('[App] 切换置顶状态失败:', e)
  }
}

const toggleMic = () => {
  isMicActive.value = !isMicActive.value
}

const sendLoading = computed(() => {
  if (!bufferMessage.value) {
    // 此时可以输出
    if (miniInputValue.value.trim()) {
      // 没有buffer，而且输入框有内容
      return false
    }
  }
  // 最后一道
  return loading.value && !cancelled.value
})

const miniTextareaRef = ref()
const sendMiniMessage = async (content?: string) => {
  content = content || miniInputValue.value.trim()
  if (!content) return
  // 如果已有buffer消息，不能发送新消息
  if (bufferMessage.value) {
    console.warn('[App] 已有待发送消息，请先取消或等待消费')
    return
  }

  // 清空输入框并重置高度
  miniInputValue.value = ''
  nextTick(() => {
    const textarea = miniTextareaRef.value as HTMLTextAreaElement
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 24) + 'px'
    }
  })

  const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  currentRequestId.value = requestId
  send(content, requestId)
}

/**
 * 取消当前对话
 */
const handleCancelChat = () => {
  if (currentRequestId.value) {
    cancelChat(currentRequestId.value)
    currentRequestId.value = null
  }
}

/**
 * 取消buffer消息
 */
const handleCancelBuffer = async (messageId: string) => {
  try {
    await cancelBufferMessage(messageId)
  } catch (error) {
    console.error('[App] 取消buffer消息失败:', error)
  }
}

const handleMiniKeyDown = (e: KeyboardEvent) => {
  const suggestions = cmdSuggestions.value
  if (showCmdAutocomplete.value && suggestions.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedSuggestionIndex.value = (selectedSuggestionIndex.value + 1) % suggestions.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedSuggestionIndex.value =
        (selectedSuggestionIndex.value - 1 + suggestions.length) % suggestions.length
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      applySuggestion(suggestions[selectedSuggestionIndex.value].cmd)
      return
    }
    if (e.key === 'Escape') {
      showCmdAutocomplete.value = false
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMiniMessage()
  }
}

/** 应用选中的补全建议 */
const applySuggestion = (cmd: string) => {
  miniInputValue.value = cmd
  showCmdAutocomplete.value = false
  selectedSuggestionIndex.value = 0
  nextTick(() => {
    const textarea = miniTextareaRef.value as HTMLTextAreaElement
    if (textarea) {
      textarea.focus()
      textarea.selectionStart = textarea.selectionEnd = cmd.length
    }
  })
}

const autoResize = (e: Event) => {
  const textarea = e.target as HTMLTextAreaElement
  textarea.style.height = 'auto'
  textarea.style.height = Math.min(textarea.scrollHeight, 80) + 'px'
  const suggestions = cmdSuggestions.value
  showCmdAutocomplete.value = suggestions.length > 0
  selectedSuggestionIndex.value = 0
}

const onMouseHoverChange = async (state) => {
  if (state) {
    await setIgnoreMouse(false)
  } else {
    await setIgnoreMouse(true, { forward: true })
  }
}

const onPositionChange = throttle(
  (position: { x: number; y: number; width: number; height: number }) => {
    modelPosition.value = position
  },
  50,
)

const onModelLoaded = async () => {
  console.log('Live2D 模型加载完成')
  modelLoaded.value = true

  // 通知主进程模型加载完成，可以关闭启动窗口
  console.log('[App] window.api:', window.api)
  console.log('[App] window.api?.ipcRenderer:', window.api?.ipcRenderer)
  if (window.api?.ipcRenderer) {
    window.api.ipcRenderer.send('model:loaded')
    console.log('[App] 已发送 model:loaded 事件')
  } else {
    console.warn('[App] ipcRenderer 不可用，无法发送 model:loaded 事件')
  }

  // 通知面板人物加载完成
  eventBus.emit(Events.MODEL_READY)

  try {
    // live2dViewerRef.value?.setParameter('ParamMouthForm', -0.4)
    // live2dViewerRef.value?.setParameter('Param110', 0.95)
    // live2dViewerRef.value?.setParameter('Param112', 0.95)
  } catch (e) {
    console.error('[onModelLoaded] 恢复状态失败:', e)
  }
}

const resetLive2D = () => {
  eventBus.emit('position_reset')
}

/**
 * 只重置面板位置，不重置人物位置（双击人物时使用）
 */
const resetPanelsOnly = () => {
  taskPanelRef.value?.resetToFollow()
  historyPanelRef.value?.resetToFollow()
  terminalPanelRef.value?.resetToFollow()
  personalityPanelRef.value?.resetToFollow()
}

const toggleToolMode = () => {
  toolMode.toggleMode()
}
</script>

<template>
  <div class="app-container">
    <div
      class="person-center"
      :style="{
        position: 'fixed',
        top: `${modelPosition.y}px`,
        left: `${modelPosition.x}px`,
        width: '1px',
        height: '1px',
        backgroundColor: 'red',
        color: 'white',
        textAlign: 'right',
        zIndex: 1000,
      }"
    ></div>

    <Live2DViewer
      v-if="live2dModelUrl"
      v-show="!isCharacterHidden"
      ref="live2dViewerRef"
      :model-url="live2dModelUrl"
      :default-params="live2dDefaultParams"
      :idle-behaviors-path="live2dIdleBehaviorsPath"
      :disabled="isCharacterHidden"
      :hide-loading="!modelLoaded"
      @loaded="onModelLoaded"
      @position-change="onPositionChange"
      @model-hover="onMouseHoverChange"
      @reset-panels="resetPanelsOnly"
    />

    <!-- 面板容器（仅用于鼠标事件检测，面板自身使用fixed定位） -->
    <div v-show="modelLoaded" class="message-panel-wrapper" @mousedown.stop>
      <!-- 面板已脱离wrapper，使用fixed定位 -->
    </div>

    <PersonalityPanel
      v-show="modelLoaded && isPanelVisible(personalityPanelRef)"
      ref="personalityPanelRef"
      class="personality-panel"
      :visible="isPanelVisible(personalityPanelRef)"
      :big-five="instantStateData.bigFive"
      :pad="instantStateData.pad"
      :summary="{
        moodDescription: instantStateData.moodDescription,
        activity: instantStateData.activity,
      }"
    />

    <TerminalPanel
      v-show="modelLoaded && isPanelVisible(terminalPanelRef)"
      ref="terminalPanelRef"
      class="terminal-panel"
      :visible="isPanelVisible(terminalPanelRef)"
    />

    <HistoryPanel
      v-if="socketReady && modelLoaded"
      v-show="modelLoaded && isPanelVisible(historyPanelRef)"
      ref="historyPanelRef"
      class="history-panel"
      :visible="isPanelVisible(historyPanelRef)"
      :load-chat-history="getChatHistory"
    />

    <TaskPanel
      v-show="isPanelVisible(taskPanelRef)"
      ref="taskPanelRef"
      class="task-panel"
      :visible="isPanelVisible(taskPanelRef)"
      :chat-visible="chatVisible"
    />

    <div
      v-show="modelLoaded && !isCharacterHidden"
      ref="miniSenderRef"
      class="mini-sender"
      :class="{ visible: true }"
      :style="wrapperStyle"
    >
      <!-- Buffer消息显示区域 -->
      <div v-if="bufferMessage" class="buffer-message-container">
        <div class="buffer-message">
          <div class="buffer-label">
            <span class="buffer-dot"></span>
            <span>待发送</span>
          </div>
          <div class="buffer-content">{{ bufferMessage.content }}</div>
          <button
            class="buffer-cancel-btn"
            title="取消"
            @click="handleCancelBuffer(bufferMessage.id)"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <path
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="tokenStats" class="token-stats">
        <span class="token-item"
          >输入: {{ tokenStats.input_tokens ?? tokenStats.inputTokens }}</span
        >
        <span class="token-item"
          >输出: {{ tokenStats.output_tokens ?? tokenStats.outputTokens }}</span
        >
        <span class="token-item"
          >总计: {{ tokenStats.total_tokens ?? tokenStats.totalTokens }}</span
        >
        <span class="token-item">{{ tokenStats.elapsedMs }}ms</span>
      </div>
      <div class="input-wrapper">
        <textarea
          ref="miniTextareaRef"
          v-model="miniInputValue"
          class="custom-input"
          placeholder=""
          rows="1"
          @keydown="handleMiniKeyDown"
          @input="autoResize"
        ></textarea>
        <div v-if="showCmdAutocomplete && cmdSuggestions.length > 0" class="cmd-autocomplete">
          <div
            v-for="(suggestion, index) in cmdSuggestions"
            :key="suggestion.cmd"
            class="cmd-item"
            :class="{ selected: index === selectedSuggestionIndex }"
            @click="applySuggestion(suggestion.cmd)"
          >
            <span class="cmd-text">{{ suggestion.cmd }}</span>
            <span class="cmd-desc">{{ suggestion.desc }}</span>
          </div>
        </div>
      </div>
      <div class="sender-footer">
        <div class="footer-tools">
          <button
            class="tool-btn"
            :class="{ active: isPinned }"
            :title="isPinned ? '取消置顶' : '置顶窗口'"
            @click.stop="togglePin"
          >
            <PushpinOutlined />
          </button>
          <button class="tool-btn" title="重置视图" @click.stop="resetLive2D">
            <ReloadOutlined />
          </button>
          <button
            class="tool-btn"
            :class="{ active: toolMode.mode.value === 'auto' }"
            :title="
              toolMode.mode.value === 'manual'
                ? '手动模式 (点击切换自动)'
                : '自动模式 (点击切换手动)'
            "
            @click.stop="toggleToolMode"
          >
            <SafetyOutlined v-if="toolMode.mode.value === 'manual'" />
            <ThunderboltOutlined v-else />
          </button>
          <button
            class="tool-btn"
            :class="{ active: isMicActive }"
            :title="isMicActive ? '关闭麦克风' : '开启麦克风'"
            @click.stop="toggleMic"
          >
            <AudioOutlined />
          </button>
          <button
            v-if="audioPlaying || audioQueueLength > 0"
            class="tool-btn"
            title="清空语音队列"
            @click.stop="clearActionQueue"
          >
            <StopOutlined />
          </button>
        </div>
        <button
          class="send-btn"
          :class="{ loading: sendLoading }"
          :title="sendLoading ? '点击取消对话' : '发送消息'"
          @click.stop="sendLoading ? handleCancelChat() : sendMiniMessage()"
        >
          <LoadingOutlined v-if="sendLoading" />
          <SendOutlined v-else />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-container {
  position: fixed;
  inset: 0;
  background: transparent;
  pointer-events: none;
}

.button-panel {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.02);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  pointer-events: auto;
}

.button-panel button {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.04);
  border: none;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  pointer-events: auto;
}

.button-panel button:hover {
  background: rgba(0, 102, 255, 0.1);
}

.pin-toggle-btn {
  color: #666;
}

.pin-toggle-btn.pinned {
  background: #0066ff;
  color: #fff;
}

.reset-btn {
  color: #666;
}

.reset-btn:hover {
  color: #0066ff;
}

.tool-mode-btn {
  color: #666;
}

.tool-mode-btn.auto {
  background: #faad14;
  color: #fff;
}

.tool-mode-btn.auto:hover {
  background: #d48806;
}

.mini-mode-toggle-btn {
  color: #666;
}

.mini-mode-toggle-btn.active {
  background: #52c41a;
  color: #fff;
}

.mini-mode-toggle-btn.active:hover {
  background: #389e0d;
}

.chat-toggle-btn {
  color: #666;
}

.chat-toggle-btn:hover {
  color: #0066ff;
}

.loading-btn {
  color: #0066ff;
  cursor: default;
  animation: spin 1s linear infinite;
}

.sender-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 8px 12px;
  background: rgba(99, 102, 241, 0.1);
  border-top: 1px solid rgba(99, 102, 241, 0.2);
  pointer-events: auto;
}

.footer-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}

.sender-footer button {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid rgba(99, 102, 241, 0.3);
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  pointer-events: auto;
  color: rgba(255, 255, 255, 0.7);
}

.sender-footer button:hover {
  background: rgba(99, 102, 241, 0.3);
  color: #fff;
  border-color: rgba(99, 102, 241, 0.6);
  box-shadow: 0 0 15px rgba(99, 102, 241, 0.4);
}

.send-btn {
  color: #0066ff;
  background: rgba(0, 102, 255, 0.1) !important;
}

.send-btn:hover {
  background: rgba(0, 102, 255, 0.2) !important;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.send-btn.loading {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.chat-area:hover {
  transform: translateX(100%);
  transition: transform 0.15s ease-out;
}

.chat-area.chat-area-left:hover {
  transform: translateX(-100%);
  transition: transform 0.15s ease-out;
}

.chat-area {
  position: absolute;
  right: -20px;
  top: 40px;
  transform: translateX(100%);
  width: 400px;
  height: 420px;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  background: transparent;
  border-radius: 16px;
  overflow: hidden;
  z-index: 90;
}

.chat-area.chat-area-left {
  right: auto;
  left: 20px;
  transform: translateX(-100%);
}

.chat-header {
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: #1a1a2e;
  border-bottom: 1px solid rgba(0, 102, 255, 0.1);
  background: rgba(255, 255, 255, 0.8);
}

.chat-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  user-select: text;
}

.mini-sender {
  position: relative;
  background:
    linear-gradient(180deg, rgba(0, 180, 220, 0.08) 0%, rgba(0, 150, 200, 0.05) 100%),
    linear-gradient(
      135deg,
      rgba(10, 10, 26, 0.7) 0%,
      rgba(26, 26, 46, 0.75) 50%,
      rgba(15, 15, 35, 0.7) 100%
    );
  border: 1px solid rgba(0, 212, 255, 0.4);
  border-radius: 8px;
  backdrop-filter: blur(30px) saturate(200%);
  -webkit-backdrop-filter: blur(30px) saturate(200%);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.3),
    0 0 40px rgba(0, 212, 255, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
  z-index: 100;
  width: 320px;
  opacity: 1;
  pointer-events: auto;
  overflow: visible;
}

/* 顶部装饰线 */
.mini-sender::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(0, 212, 255, 0.5), transparent);
}

/* 输入框包装 */
.input-wrapper {
  position: relative;
  padding: 12px 16px 0;
}

/* Token统计条 */
.token-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  background: rgba(99, 102, 241, 0.15);
  border-bottom: 1px solid rgba(99, 102, 241, 0.3);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
}

.token-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 自定义输入框 */
.custom-input {
  width: 100%;
  height: 24px;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.95);
  min-height: 24px;
  max-height: 80px;
  padding: 0;
  caret-color: #00ffff;
}

.custom-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.custom-input:focus::placeholder {
  color: rgba(255, 255, 255, 0.25);
}

/* /cmd 自动补全菜单 */
.cmd-autocomplete {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: rgba(20, 30, 40, 0.95);
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 8px;
  margin-bottom: 4px;
  max-height: 150px;
  overflow-y: auto;
  backdrop-filter: blur(10px);
  z-index: 1000;
  pointer-events: auto;
}

.cmd-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.cmd-item:hover,
.cmd-item.selected {
  background: rgba(0, 212, 255, 0.15);
}

.cmd-item.selected {
  border-left: 2px solid #00d4ff;
}

.cmd-text {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  color: #00d4ff;
}

.cmd-desc {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

/* 底部工具栏 */
.sender-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 212, 255, 0.05);
  border-top: 1px solid rgba(0, 212, 255, 0.15);
}

.footer-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tool-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(0, 212, 255, 0.08);
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  pointer-events: auto;
  color: rgba(0, 255, 255, 0.7);
}

.tool-btn:hover {
  background: rgba(0, 212, 255, 0.2);
  color: #00ffff;
  box-shadow: 0 0 10px rgba(0, 255, 255, 0.3);
}

.tool-btn.active {
  background: rgba(0, 212, 255, 0.25);
  border-color: rgba(0, 255, 255, 0.4);
  color: #00ffff;
  box-shadow: 0 0 12px rgba(0, 255, 255, 0.4);
}

.tool-btn.active:hover {
  background: rgba(0, 212, 255, 0.35);
  box-shadow: 0 0 16px rgba(0, 255, 255, 0.5);
}

/* 发送按钮 */
.send-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, #00d4ff, #00ffff);
  border: none;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  pointer-events: auto;
  color: #0a0a1a;
  box-shadow:
    0 0 15px rgba(0, 212, 255, 0.5),
    0 0 30px rgba(0, 255, 255, 0.3);
}

.send-btn:hover:not(:disabled) {
  transform: scale(1.08);
  box-shadow:
    0 0 20px rgba(0, 212, 255, 0.7),
    0 0 40px rgba(0, 255, 255, 0.5);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.send-btn.loading {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 选中文本颜色 */
.mini-sender ::selection {
  background: rgba(0, 255, 255, 0.4);
  color: #ffffff;
}

.mini-sender ::-moz-selection {
  background: rgba(0, 255, 255, 0.4);
  color: #ffffff;
}

/* 滚动条样式 */
.custom-input::-webkit-scrollbar {
  width: 4px;
}

.custom-input::-webkit-scrollbar-track {
  background: rgba(0, 212, 255, 0.05);
  border-radius: 2px;
}

.custom-input::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, #00d4ff, #00ffff);
  border-radius: 2px;
  opacity: 0.6;
}

.custom-input::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, #00ffff, #00d4ff);
  opacity: 0.8;
}

.mini-sender:focus-within {
  border-color: rgba(99, 102, 241, 0.6);
  box-shadow:
    0 0 30px rgba(99, 102, 241, 0.4),
    0 0 60px rgba(236, 72, 153, 0.2),
    inset 0 0 40px rgba(99, 102, 241, 0.1);
}

.mini-sender :deep(.ant-sender) {
  background: transparent;
  color: rgba(255, 255, 255, 0.9);
}

.mini-sender :deep(.ant-sender):focus-within {
  background: transparent;
  box-shadow: none;
}

.mini-sender :deep(.ant-sender-textarea) {
  font-size: 14px !important;
  line-height: 1.5 !important;
  padding: 10px 16px !important;
  background: transparent !important;
  color: rgba(255, 255, 255, 0.9) !important;
  caret-color: rgba(99, 102, 241, 1) !important;
}

:deep(.ant-sender-content textarea) {
  overflow: auto;
}

.mini-sender :deep(.ant-sender-textarea::placeholder) {
  color: rgba(255, 255, 255, 0.4) !important;
}

.mini-sender :deep(.ant-sender-footer) {
  padding-block-end: 4px;
}

.mini-sender :deep(.ant-sender-actions) {
  display: none !important;
}

.mini-sender :deep(.send-btn) {
  width: 36px !important;
  height: 36px !important;
  border-radius: 50% !important;
  background: linear-gradient(135deg, #6366f1, #ec4899) !important;
  border: none !important;
  box-shadow:
    0 0 20px rgba(99, 102, 241, 0.6),
    0 0 40px rgba(236, 72, 153, 0.4),
    inset 0 0 10px rgba(255, 255, 255, 0.2) !important;
  transition: all 0.3s ease !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
}

.mini-sender :deep(.send-btn:hover:not(:disabled)) {
  transform: scale(1.1);
  box-shadow:
    0 0 30px rgba(99, 102, 241, 0.8),
    0 0 60px rgba(236, 72, 153, 0.6),
    inset 0 0 15px rgba(255, 255, 255, 0.3) !important;
}

.mini-sender :deep(.send-btn:disabled) {
  opacity: 0.5;
  background: linear-gradient(135deg, #0066ff, #7c3aed) !important;
}

.mini-sender :deep(.send-btn .anticon) {
  color: #fff !important;
  font-size: 16px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
}

.mini-sender :deep(.send-btn .anticon-loading) {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

.ai-popup {
  position: fixed;
  z-index: 1000;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  pointer-events: auto;
  flex-direction: column;
}

/* 主题色 */
.ai-popup.theme-primary {
  border-top: 4px solid #0066ff;
}

.ai-popup.theme-success {
  border-top: 4px solid #52c41a;
}

.ai-popup.theme-warning {
  border-top: 4px solid #faad14;
}

.ai-popup.theme-error {
  border-top: 4px solid #ff4d4f;
}

/* 弹窗头部 */
.popup-header {
  padding: 12px 16px 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(0, 0, 0, 0.02);
}

.popup-title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

/* 弹窗内容 */
.popup-content {
  width: 100%;
  flex: 1;
  padding: 16px;
  overflow: auto;
  font-size: 14px;
  color: #333;
  box-sizing: border-box;
}

.popup-content.has-title {
  padding-top: 12px;
}

/* report 类型样式 */
.popup-type-report .popup-content {
  font-size: 13px;
  line-height: 1.6;
}

.popup-type-report .popup-content table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
}

.popup-type-report .popup-content th,
.popup-type-report .popup-content td {
  border: 1px solid #e8e8e8;
  padding: 8px 12px;
  text-align: left;
}

.popup-type-report .popup-content th {
  background: #f5f5f5;
  font-weight: 600;
}

.popup-type-report .popup-content pre {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.popup-type-report .popup-content code {
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.popup-type-report .popup-content ul,
.popup-type-report .popup-content ol {
  margin: 8px 0;
  padding-left: 20px;
}

.popup-type-report .popup-content li {
  margin: 4px 0;
}

.popup-type-report .popup-content h1,
.popup-type-report .popup-content h2,
.popup-type-report .popup-content h3 {
  margin: 16px 0 8px;
  color: #333;
}

.popup-type-report .popup-content h1 {
  font-size: 18px;
}

.popup-type-report .popup-content h2 {
  font-size: 16px;
}

.popup-type-report .popup-content h3 {
  font-size: 14px;
}

.popup-close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border: none;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 50%;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: #666;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  pointer-events: auto;
  z-index: 1001;
}

.popup-close:hover {
  background: rgba(0, 0, 0, 0.2);
}

/* 有标题时关闭按钮位置调整 */
.ai-popup:has(.popup-header) .popup-close {
  top: 6px;
}

/* 拖拽调整大小手柄 */
.ai-popup .popup-resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 20px;
  height: 20px;
  cursor: nwse-resize;
  z-index: 1002;
  background: linear-gradient(
    135deg,
    transparent 40%,
    rgba(0, 0, 0, 0.2) 40%,
    rgba(0, 0, 0, 0.2) 60%,
    transparent 60%
  );
}

.ai-popup .popup-resize-handle:hover {
  background: linear-gradient(
    135deg,
    transparent 40%,
    rgba(0, 102, 255, 0.4) 40%,
    rgba(0, 102, 255, 0.4) 60%,
    transparent 60%
  );
}

/* Buffer消息样式 */
.buffer-message-container {
  margin-bottom: 8px;
  animation: fadeIn 0.3s ease-out;
}

.buffer-message {
  position: relative;
  padding: 8px 10px;
  background: linear-gradient(135deg, rgba(255, 193, 7, 0.2) 0%, rgba(255, 160, 0, 0.15) 100%);
  border-left: 2px solid #ffc107;
  border-radius: 6px;
  box-shadow:
    inset 0 0 20px rgba(255, 193, 7, 0.08),
    0 0 15px rgba(255, 193, 7, 0.15);
}

.buffer-label {
  font-size: 9px;
  color: #ffc107;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.buffer-dot {
  width: 5px;
  height: 5px;
  background: #ffc107;
  border-radius: 50%;
  box-shadow: 0 0 6px #ffc107;
  animation: pulse 1.5s infinite;
}

.buffer-content {
  color: #fff8e1;
  line-height: 1.5;
  font-size: 12px;
  word-break: break-word;
  padding-right: 22px;
}

.buffer-cancel-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 18px;
  height: 18px;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.buffer-cancel-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.8);
  }
}
</style>
