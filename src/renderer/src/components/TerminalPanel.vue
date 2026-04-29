<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSocket } from '../composables/useSocket'
import { bindToggleMouseEvent } from '../util'
import { eventBus, Events } from '../eventBus'
import { usePanelPosition } from '../composables/usePanelPosition'

interface Props {
  visible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  visible: true,
})

const panelRef = ref<HTMLElement | null>(null)

/** 使用新的面板定位系统（modelPosition 通过 inject 获取） */
const {
  mode,
  expandDirection,
  resetToFollow,
  isHovered,
  isLocked,
  handleMouseEnter,
  handleMouseLeave,
  handleToggleLock,
} = usePanelPosition('terminal', panelRef, 280)

const { sendCommand } = useSocket()
const sessionCount = ref(0)

onUnmounted(() => {
  offSocketReady()
  offTerminalEvents()
})

const loadTerminalInfo = async () => {
  try {
    const result: any = await sendCommand('terminal:list', {})
    if (result?.sessions && Array.isArray(result.sessions)) {
      sessionCount.value = result.sessions.length
    }
  } catch (e) {
    console.error('[TerminalPanel] 加载终端信息失败:', e)
  }
}

const offSocketReady = eventBus.on(Events.SOCKET_READY, () => {
  loadTerminalInfo()
})

const offTerminalEvents = () => {
  eventBus.off(Events.TERMINAL_SESSION_CREATED, loadTerminalInfo)
  eventBus.off(Events.TERMINAL_SESSION_CLOSED, loadTerminalInfo)
  eventBus.off(Events.TERMINAL_STATUS_CHANGED, loadTerminalInfo)
}

eventBus.on(Events.TERMINAL_SESSION_CREATED, loadTerminalInfo)
eventBus.on(Events.TERMINAL_SESSION_CLOSED, loadTerminalInfo)
eventBus.on(Events.TERMINAL_STATUS_CHANGED, loadTerminalInfo)

const openTerminalManager = () => {
  window.api?.openTerminalManager()
}

onMounted(() => {
  if (panelRef.value) {
    bindToggleMouseEvent(panelRef.value)
  }
})

/** 是否启用呼吸感动效（当前面板未锁定时） */
const isBreathingEnabled = computed(() => {
  return !isLocked.value
})

defineExpose({
  loadTerminalInfo,
  resetToFollow,
  get mode() {
    return mode.value
  },
})
</script>

<template>
  <div
    ref="panelRef"
    class="terminal-panel"
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
              d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"
            />
          </svg>
        </div>
        <span class="header-title">终端</span>
        <!-- 独立模式图标 - 断开的链接 -->
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
        <!-- 锁定标识 -->
        <svg v-if="isLocked" class="lock-icon" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"
          />
        </svg>
        <div v-if="sessionCount > 0" class="corner-badge">
          {{ sessionCount }}
        </div>
      </div>
    </div>

    <div class="detail-content">
      <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
      <div class="status-text" @click.stop="openTerminalManager">
        <span class="status-dot active"></span>
        {{ sessionCount }} 个激活终端
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  position: fixed;
  pointer-events: auto;
  width: 170px;
  max-height: 40px;
  background: linear-gradient(135deg, rgba(10, 10, 26, 0.85) 0%, rgba(20, 20, 45, 0.9) 100%);
  border: 1px solid rgba(0, 255, 136, 0.35);
  border-radius: 8px;
  padding: 12px;
  transition:
    max-height 0.4s ease,
    width 0.2s ease 0.6s,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    left 0.5s ease,
    top 0.5s ease;
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.4),
    0 0 30px rgba(0, 255, 136, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  overflow: hidden;
  z-index: 101;
}

.terminal-panel:hover {
  z-index: 201;
}

.terminal-panel.breathing:not(.expanded) {
  animation: breathe 3s ease-in-out infinite;
  animation-delay: 0s;
}

.terminal-panel.expanded {
  width: 300px;
  max-height: 120px;
  border-color: rgba(0, 255, 136, 0.6);
  box-shadow:
    0 6px 30px rgba(0, 0, 0, 0.5),
    0 0 40px rgba(0, 255, 136, 0.15);
  transition:
    width 0.2s ease,
    max-height 0.4s ease 0.4s,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    left 0.5s ease,
    top 0.5s ease;
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
  width: 12px;
  height: 12px;
  border-color: #00ff88;
  border-style: solid;
  opacity: 0.6;
}

.panel-corner.tl {
  top: 3px;
  left: 3px;
  border-width: 2px 0 0 2px;
  border-radius: 3px 0 0 0;
}

.panel-corner.tr {
  top: 3px;
  right: 3px;
  border-width: 2px 2px 0 0;
  border-radius: 0 3px 0 0;
}

.panel-corner.bl {
  bottom: 3px;
  left: 3px;
  border-width: 0 0 2px 2px;
  border-radius: 0 0 0 3px;
}

.panel-corner.br {
  bottom: 3px;
  right: 3px;
  border-width: 0 2px 2px 0;
  border-radius: 0 0 3px 0;
}

.scan-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(0, 255, 136, 0.5), transparent);
  animation: scan 5s linear infinite;
  opacity: 0.3;
  animation-delay: -2.8s;
}

@keyframes scan {
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
  padding-bottom: 0;
  border-bottom: none;
  transition: all 0.3s ease;
  user-select: none;
  cursor: move;
}

.terminal-panel.expanded .panel-header {
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 255, 136, 0.15);
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

/** 独立模式图标 */
.mode-icon-indicator {
  width: 12px;
  height: 12px;
  color: #00ff88;
  filter: drop-shadow(0 0 3px rgba(0, 255, 136, 0.5));
  flex-shrink: 0;
}

.header-icon {
  width: 14px;
  height: 14px;
  color: #00ff88;
  opacity: 0.8;
}

.header-title {
  font-size: 11px;
  font-weight: 600;
  color: #00ff88;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.lock-icon {
  width: 14px;
  height: 14px;
  color: #00ff88;
  filter: drop-shadow(0 0 4px rgba(0, 255, 136, 0.8));
  flex-shrink: 0;
}

.corner-badge {
  width: 18px;
  height: 18px;
  line-height: 18px;
  background: rgba(0, 255, 136, 0.25);
  border: 1px solid rgba(0, 255, 136, 0.5);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: #00ff88;
  text-align: center;
  box-shadow: 0 0 10px rgba(0, 255, 136, 0.3);
  flex-shrink: 0;
  transform: translateY(-1px);
}

.detail-content {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    max-height 0.3s ease,
    opacity 0.3s ease;
}

.terminal-panel.expanded .detail-content {
  max-height: 100px;
  opacity: 1;
}

.status-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 8px;
  cursor: pointer;
  transition: color 0.2s ease;
}

.status-text:hover {
  color: #00ff88;
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
  background: #00ff88;
  box-shadow: 0 0 8px #00ff88;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(0.85);
  }
}
</style>
