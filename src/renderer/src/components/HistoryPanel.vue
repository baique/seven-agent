<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { bindToggleMouseEvent } from '../util'
import { useMessageStore } from '../composables/useMessageStore'
import { useHistoryLoader } from '../composables/useHistoryLoader'
import { usePanelPosition } from '../composables/usePanelPosition'
import { storeToRefs } from 'pinia'
import { toolMessageRenderers } from './tool-message'
import MessageBubble from './MessageBubble.vue'
import { eventBus, Events } from '../eventBus'
import type { RawMessage, HistoryLoadParams } from '../types/message'
import { debounce, throttle } from 'lodash-es'

/** 消息列表最大展示数量 */
const MAX_MESSAGE_COUNT = 120
/** 滚动到底部判定阈值（像素） */
const SCROLL_BOTTOM_THRESHOLD = 100

interface Props {
  visible?: boolean
  loadChatHistory: (params: HistoryLoadParams) => Promise<{
    history: RawMessage[]
    hasMore?: boolean
  }>
}

const props = withDefaults(defineProps<Props>(), {
  visible: true,
})

/** 使用新的面板定位系统（modelPosition通过inject获取） */
const panelRef = ref<HTMLElement | null>(null)
const {
  mode,
  expandDirection,
  resetToFollow,
  isHovered,
  isLocked,
  handleMouseEnter,
  handleMouseLeave,
  handleToggleLock,
} = usePanelPosition('history', panelRef, 180, {})

const messageStore = useMessageStore()
const { historyMessages, messages: currentMessages, summaryMessage } = storeToRefs(messageStore)
const { loadHistory: loadHistoryToStore, prependHistory, setScrollToBottom } = messageStore

const { historyLoaded, historyLoading, hasMore, loadHistory, loadMore } = useHistoryLoader()

const initHistory = async () => {
  if (historyLoaded.value) return
  const history = await loadHistory(props.loadChatHistory)
  if (history.length > 0) {
    setScrollToBottom(() => {
      doScrollToBottom()
      return true
    })

    loadHistoryToStore(history)
  }
}

/** 限制消息数量最多120条，超过则丢弃最早的 */
const messages = computed(() => {
  const allMessages = historyMessages.value.concat(currentMessages.value)
  if (allMessages.length <= MAX_MESSAGE_COUNT) {
    return allMessages
  }
  return allMessages.slice(-MAX_MESSAGE_COUNT)
})

const scrollContainerRef = ref<HTMLElement | null>(null)
/** 滚动条是否在底部 - 初始为 false，等计算后再更新 */
const isAtBottom = ref(true)
const isLoadingMore = ref(false)

let historyLoadTimer: ReturnType<typeof setTimeout> | null = null
let panelVisibleTimer: ReturnType<typeof setTimeout> | null = null
let panelVisibilityObserver: IntersectionObserver | null = null

onUnmounted(() => {
  if (historyLoadTimer) clearTimeout(historyLoadTimer)
  if (panelVisibleTimer) clearTimeout(panelVisibleTimer)
  if (panelVisibilityObserver) {
    panelVisibilityObserver.disconnect()
    panelVisibilityObserver = null
  }
})

onMounted(() => {
  if (panelRef.value) {
    bindToggleMouseEvent(panelRef.value)
  }

  // 立即加载
  initHistory()
})

/** 消息总数 */
const messageCount = computed(() => messages.value.length)

/** 消息气泡数据 */
const bubbleItems = computed(() => {
  const items = messages.value
    .filter((msg) => {
      if (!msg.content || msg.content.trim().length === 0) {
        if (!msg.toolCalls || msg.toolCalls.length === 0) {
          return false
        }
      }
      return true
    })
    .map((msg) => ({
      id: msg.id,
      type: msg.type,
      toolCalls: msg.toolCalls,
      content: msg.content,
      loading: msg.status === 'loading',
      typing: msg.status === 'streaming',
      isSubagent: msg.isSubagent,
    }))

  if (summaryMessage.value) {
    items.push({
      id: summaryMessage.value.id,
      type: 'system',
      content: summaryMessage.value.content,
      loading: summaryMessage.value.status === 'loading',
      typing: false,
      toolCalls: undefined,
      isSubagent: undefined,
    })
  }

  return items
})

const doOffset = ref(false)
/**
 * 滚动到底部
 */
const doScrollToBottom = throttle(
  async (force = false) => {
    // 只有在底部时才执行滚动
    if (!isAtBottom.value && !force) return

    await nextTick()
    const scrollContainer = scrollContainerRef.value
    if (!scrollContainer) return

    doOffset.value = true
    scrollContainer.scrollTop = scrollContainer.scrollHeight
    console.log(
      '预期滚动到底部',
      scrollContainer.scrollTop,
      scrollContainer.scrollHeight,
      scrollContainer.clientHeight,
    )
    isAtBottom.value = true
    requestAnimationFrame(() => {
      doOffset.value = false

      console.log(
        '滚动到底部',
        scrollContainer.scrollTop,
        scrollContainer.scrollHeight,
        scrollContainer.clientHeight,
      )
    })
  },
  160,
  { trailing: false },
)

/** 处理滚动事件 - 更新 isAtBottom 状态并检查加载更多 */
const handleScroll = () => {
  if (doOffset.value) return

  const scrollContainer = scrollContainerRef.value
  if (!scrollContainer) return

  const distanceFromBottom =
    scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight

  // 这个值什么时候能够更新呢？
  isAtBottom.value = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD

  // 检查是否需要加载更多
  if (
    scrollContainer.scrollTop < 50 &&
    hasMore.value &&
    !historyLoading.value &&
    !isLoadingMore.value
  ) {
    isLoadingMore.value = true
    const prevScrollHeight = scrollContainer.scrollHeight
    loadMore(props.loadChatHistory).then((newHistory) => {
      if (newHistory.length > 0) {
        prependHistory(newHistory)
        nextTick(() => {
          const newScrollHeight = scrollContainer.scrollHeight
          scrollContainer.scrollTop = newScrollHeight - prevScrollHeight
          setTimeout(() => {
            isLoadingMore.value = false
          }, 300)
        })
      } else {
        isLoadingMore.value = false
      }
    })
  }
}

/** 监听流式消息内容变化 - 如果在底部则置底 */
const lastMessage = computed(() => {
  const items = bubbleItems.value
  return items.length > 0 ? items[items.length - 1] : null
})

watch(
  () => bubbleItems.value.length,
  () => doScrollToBottom(),
)

watch(
  () => props.visible,
  () => {
    console.log(props.visible)
    nextTick(() => {
      if (props.visible) {
        console.log('触发滚动', props.visible)
        doScrollToBottom(true)
      }
    })
  },
)

watch(
  () => {
    const msg = lastMessage.value
    return msg?.content
  },
  () => doScrollToBottom(),
)

/** 是否启用呼吸感动效（当前面板未锁定时） */
const isBreathingEnabled = computed(() => {
  return !isLocked.value
})

defineExpose({
  resetToFollow,
  get mode() {
    return mode.value
  },
})
</script>

<template>
  <div
    ref="panelRef"
    class="history-panel"
    :class="[
      `pos-${expandDirection}`,
      { expanded: isHovered || isLocked, locked: isLocked, breathing: isBreathingEnabled },
    ]"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
    @contextmenu.prevent="handleToggleLock"
  >
    <div class="panel-corner tl"></div>
    <div class="panel-corner tr"></div>
    <div class="panel-corner bl"></div>
    <div class="panel-corner br"></div>

    <div class="scan-line"></div>

    <div class="panel-header">
      <div class="header-left">
        <div class="header-icon">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"
            />
          </svg>
        </div>
        <span class="header-title">历史</span>
        <svg
          v-if="mode === 'independent'"
          class="mode-icon-indicator"
          viewBox="0 0 24 24"
          fill="currentColor"
          title="独立模式"
        >
          <path
            d="M17 7h-4v2h4c1.65 0 3 1.35 3 3s-1.35 3-3 3h-4v2h4c2.76 0 5-2.24 5-5s-2.24-5-5-5zm-6 8H7c-1.65 0-3-1.35-3-3s1.35-3 3-3h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-2zm-3-4h8v2H8z"
          />
        </svg>
      </div>
      <div class="header-right">
        <svg v-if="isLocked" class="lock-icon" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"
          />
        </svg>
        <div v-if="messageCount > 0" class="corner-badge">
          {{ messageCount }}
        </div>
      </div>
    </div>

    <div class="panel-summary">
      <div class="status-text">
        <template v-if="messageCount === 0">
          <span class="status-dot idle"></span>
          无消息
        </template>
        <template v-else>
          <span class="status-dot active"></span>
          {{ messageCount }} 条消息
        </template>
      </div>
    </div>

    <div class="detail-content">
      <div ref="scrollContainerRef" class="messages-container" @scroll="handleScroll">
        <div v-if="historyLoading" class="load-more-indicator">
          <span class="loading-spinner"></span>
          <span>加载中...</span>
        </div>

        <div v-if="bubbleItems.length > 0" class="native-list">
          <div
            v-for="(item, index) in bubbleItems"
            :key="item.id + '-' + index"
            class="message-item"
            :data-index="index"
          >
            <div
              :class="[
                'message',
                item.type === 'human'
                  ? 'user-message'
                  : item.type === 'system'
                    ? 'system-message'
                    : 'ai-message',
              ]"
            >
              <div v-if="item.type === 'human'" class="message-label">
                <span class="label-dot"></span>
                <span>USER</span>
              </div>
              <div v-if="item.content" class="message-content">
                <MessageBubble :id="item.id" :content="item.content" />
              </div>

              <div
                v-if="item.type === 'ai' && item.toolCalls && item.toolCalls.length > 0"
                class="tool-calls-list"
              >
                <component
                  :is="toolMessageRenderers[toolCall.name] || toolMessageRenderers.default"
                  v-for="toolCall in item.toolCalls"
                  :key="toolCall.id"
                  :tool-call="toolCall"
                />
              </div>
            </div>
          </div>
        </div>

        <div v-if="bubbleItems.length === 0" class="chat-empty-state">
          <div class="chat-empty-title">历史消息</div>
          <div class="chat-empty-hint">暂无消息记录</div>
        </div>
      </div>
    </div>

    <Transition name="fade">
      <button
        v-if="!isAtBottom && (isHovered || isLocked)"
        class="scroll-to-bottom-btn"
        title="回到底部"
        @click="doScrollToBottom(true)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
        </svg>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.history-panel {
  position: fixed;
  pointer-events: auto;
  width: 170px;
  max-height: 40px;
  background:
    linear-gradient(180deg, rgba(0, 180, 220, 0.08) 0%, rgba(0, 150, 200, 0.05) 100%),
    linear-gradient(
      135deg,
      rgba(10, 10, 26, 0.72) 0%,
      rgba(26, 26, 46, 0.78) 50%,
      rgba(15, 15, 35, 0.72) 100%
    );
  border: 1px solid rgba(0, 212, 255, 0.4);
  border-radius: 8px;
  padding: 12px;
  box-sizing: border-box;
  transition:
    max-height 0.4s ease,
    width 0.2s ease 0.6s,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    left 0.5s ease,
    top 0.5s ease;
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.4),
    0 0 30px rgba(0, 212, 255, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  overflow: hidden;
  z-index: 101;
}

.history-panel:hover {
  z-index: 201;
}

.history-panel::before {
  content: '';
  position: absolute;
  top: -1px;
  left: -1px;
  right: -1px;
  bottom: -1px;
  border-radius: 9px;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    rgba(0, 212, 255, 0.8) 60deg,
    rgba(0, 255, 255, 0.8) 120deg,
    transparent 180deg,
    transparent 360deg
  );
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  padding: 1px;
  animation: borderRotate 3s linear infinite;
  pointer-events: none;
  z-index: 20;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.history-panel.expanded::before {
  opacity: 1;
}

@keyframes borderRotate {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.history-panel.breathing:not(.expanded) {
  animation: breathe 3s ease-in-out infinite;
  animation-delay: 0.5s;
}

.history-panel.expanded {
  width: 300px;
  max-height: 450px;
  border-color: rgba(0, 212, 255, 0.6);
  box-shadow:
    0 6px 30px rgba(0, 0, 0, 0.5),
    0 0 40px rgba(0, 212, 255, 0.15);
  transition:
    width 0.2s ease,
    max-height 0.4s ease 0.4s,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

@keyframes breathe {
  0%,
  100% {
    transform: translateY(0);
  }
  25% {
    transform: translateY(-4px);
  }
  50% {
    transform: translateY(-6px);
  }
  75% {
    transform: translateY(-4px);
  }
}

.panel-corner {
  position: absolute;
  width: 16px;
  height: 16px;
  border-color: #00d4ff;
  border-style: solid;
  opacity: 0.8;
  z-index: 10;
}

.panel-corner.tl {
  top: 4px;
  left: 4px;
  border-width: 2px 0 0 2px;
  border-top-left-radius: 4px;
}

.panel-corner.tr {
  top: 4px;
  right: 4px;
  border-width: 2px 2px 0 0;
  border-top-right-radius: 4px;
}

.panel-corner.bl {
  bottom: 4px;
  left: 4px;
  border-width: 0 0 2px 2px;
  border-bottom-left-radius: 4px;
}

.panel-corner.br {
  bottom: 4px;
  right: 4px;
  border-width: 0 2px 2px 0;
  border-bottom-right-radius: 4px;
}

.panel-corner::before {
  content: '';
  position: absolute;
  width: 4px;
  height: 4px;
  background: #00ffff;
  border-radius: 50%;
  box-shadow:
    0 0 6px #00ffff,
    0 0 12px #00ffff;
}

.panel-corner.tl::before {
  top: -1px;
  left: -1px;
}

.panel-corner.tr::before {
  top: -1px;
  right: -1px;
}

.panel-corner.bl::before {
  bottom: -1px;
  left: -1px;
}

.panel-corner.br::before {
  bottom: -1px;
  right: -1px;
}

.scan-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(0, 255, 255, 0.8) 50%, transparent 100%);
  animation: scanMove 3s linear infinite;
  opacity: 0.5;
  pointer-events: none;
  z-index: 10;
}

@keyframes scanMove {
  0% {
    top: 0;
  }
  100% {
    top: 100%;
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0;
  transition: margin-bottom 0.3s ease;
  position: relative;
  top: -2px;
  user-select: none;
  cursor: move;
}

.history-panel.expanded .panel-header {
  margin-bottom: 10px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mode-icon-indicator {
  width: 12px;
  height: 12px;
  color: #00d4ff;
  filter: drop-shadow(0 0 3px rgba(0, 212, 255, 0.5));
  flex-shrink: 0;
}

.header-icon {
  width: 18px;
  height: 18px;
  color: #00d4ff;
  filter: drop-shadow(0 0 5px rgba(0, 212, 255, 0.5));
  flex-shrink: 0;
}

.header-icon svg {
  width: 100%;
  height: 100%;
}

.header-title {
  font-size: 13px;
  font-weight: 600;
  color: #00d4ff;
  text-shadow: 0 0 10px rgba(0, 212, 255, 0.3);
  letter-spacing: 1px;
}

.lock-icon {
  width: 14px;
  height: 14px;
  color: #00d4ff;
  filter: drop-shadow(0 0 4px rgba(0, 212, 255, 0.8));
  flex-shrink: 0;
}

.corner-badge {
  width: 18px;
  height: 18px;
  line-height: 18px;
  background: rgba(0, 212, 255, 0.25);
  border: 1px solid rgba(0, 212, 255, 0.5);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: #00d4ff;
  text-align: center;
  box-shadow: 0 0 10px rgba(0, 212, 255, 0.3);
  flex-shrink: 0;
  transform: translateY(-1px);
}

.panel-summary {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    max-height 0.3s ease,
    opacity 0.3s ease,
    margin-bottom 0.3s ease;
  margin-bottom: 0;
  position: relative;
}

.history-panel.expanded .panel-summary {
  max-height: 50px;
  opacity: 1;
  margin-bottom: 10px;
}

.status-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.status-dot.idle {
  background: #666;
}

.status-dot.active {
  background: #00d4ff;
  box-shadow: 0 0 8px #00d4ff;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.detail-content {
  height: 320px;
  opacity: 0;
  transition: opacity 0.3s ease;
  position: relative;
}

.history-panel.expanded .detail-content {
  opacity: 1;
}

.messages-container {
  height: 320px;
  overflow-y: auto;
  padding: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 212, 255, 0.4) transparent;
  /* scroll-behavior: smooth; */
}

.messages-container::-webkit-scrollbar {
  width: 4px;
}

.messages-container::-webkit-scrollbar-track {
  background: transparent;
}

.messages-container::-webkit-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    rgba(0, 212, 255, 0.2) 0%,
    rgba(0, 212, 255, 0.6) 50%,
    rgba(0, 212, 255, 0.2) 100%
  );
  border-radius: 2px;
  box-shadow: 0 0 8px rgba(0, 212, 255, 0.4);
}

.native-list {
  width: 100%;
}

.message-item {
  width: 100%;
}

.message {
  margin-bottom: 12px;
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.ai-message .message-content {
  color: #e0f7ff;
  line-height: 1.6;
  font-size: 13px;
  padding: 10px 12px;
  background: rgba(0, 150, 200, 0.1);
  border-left: 2px solid #00d4ff;
  border-radius: 0 6px 6px 0;
  box-shadow: inset 0 0 20px rgba(0, 212, 255, 0.03);
}

.user-message {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.user-message .message-label {
  font-size: 10px;
  color: #ff6b9d;
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.label-dot {
  width: 6px;
  height: 6px;
  background: #ff6b9d;
  border-radius: 50%;
  box-shadow: 0 0 8px #ff6b9d;
  animation: labelPulse 1.5s infinite;
}

@keyframes labelPulse {
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

.user-message .message-content {
  color: #ffe0eb;
  line-height: 1.6;
  font-size: 13px;
  padding: 10px 12px;
  background: linear-gradient(135deg, rgba(255, 107, 157, 0.15) 0%, rgba(180, 80, 130, 0.1) 100%);
  border-left: 2px solid #ff6b9d;
  border-radius: 6px 0 0 6px;
  box-shadow:
    inset 0 0 20px rgba(255, 107, 157, 0.05),
    0 0 15px rgba(255, 107, 157, 0.1);
  max-width: 90%;
  word-break: break-word;
}

.tool-calls-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chat-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
}

.chat-empty-title {
  font-size: 14px;
  color: #00d4ff;
  text-shadow: 0 0 20px rgba(0, 212, 255, 0.5);
  margin-bottom: 6px;
}

.chat-empty-hint {
  font-size: 12px;
  color: #888;
}

.system-message {
  text-align: center;
}

.system-message .message-content {
  color: #a0d8ef;
  font-size: 12px;
  padding: 8px 16px;
  background: rgba(0, 150, 200, 0.15);
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 0;
  display: inline-block;
}

.load-more-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px;
  color: #00d4ff;
  font-size: 12px;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 212, 255, 0.3);
  border-top-color: #00d4ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.scroll-to-bottom-btn {
  position: absolute;
  bottom: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 60px;
  height: 12px;
  background: linear-gradient(180deg, rgba(0, 180, 220, 0.25) 0%, rgba(0, 150, 200, 0.4) 100%);
  border: none;
  border-top: 1px solid rgba(0, 212, 255, 0.5);
  color: #00d4ff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  clip-path: polygon(15% 0%, 85% 0%, 100% 100%, 0% 100%);
  z-index: 10;
}

.scroll-to-bottom-btn:hover {
  background: linear-gradient(180deg, rgba(0, 200, 240, 0.35) 0%, rgba(0, 170, 220, 0.5) 100%);
  border-top-color: rgba(0, 212, 255, 0.8);
  box-shadow: 0 -4px 20px rgba(0, 212, 255, 0.3);
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}
</style>
