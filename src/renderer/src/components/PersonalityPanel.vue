<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted } from 'vue'
import { bindToggleMouseEvent } from '../util'
import { usePanelPosition } from '../composables/usePanelPosition'

export interface BigFiveData {
  extraversion: number
  agreeableness: number
  openness: number
  conscientiousness: number
  neuroticism: number
}

export interface PADData {
  pleasure: number
  arousal: number
  dominance: number
}

export interface PersonalitySummary {
  moodDescription: string
  activity: string
}

interface Props {
  visible?: boolean
  bigFive?: BigFiveData
  pad?: PADData
  summary?: PersonalitySummary
}

const props = withDefaults(defineProps<Props>(), {
  visible: true,
  bigFive: () => ({
    extraversion: 0.5,
    agreeableness: 0.5,
    openness: 0.5,
    conscientiousness: 0.5,
    neuroticism: 0.5,
  }),
  pad: () => ({
    pleasure: 0.5,
    arousal: 0.5,
    dominance: 0.5,
  }),
  summary: () => ({
    moodDescription: '平静',
    activity: '待机',
  }),
})

const panelRef = ref<HTMLElement | null>(null)

/** 使用新的面板定位系统（modelPosition通过inject获取） */
const {
  mode,
  expandDirection,
  isAnimating,
  toggleMode,
  resetToFollow,
  checkBounds,
  isInFollowZone,
  isHovered,
  isLocked,
  handleMouseEnter,
  handleMouseLeave,
  handleToggleLock,
} = usePanelPosition('personality', panelRef, 450)

onUnmounted(() => {})

onMounted(() => {
  if (panelRef.value) {
    bindToggleMouseEvent(panelRef.value)
  }
})

const bigFiveLabels: Record<keyof BigFiveData, string> = {
  extraversion: '外倾性',
  agreeableness: '宜人性',
  openness: '开放性',
  conscientiousness: '尽责性',
  neuroticism: '神经质',
}

const padLabels: Record<keyof PADData, string> = {
  pleasure: '愉悦度',
  arousal: '唤醒度',
  dominance: '支配度',
}

const bigFiveBars = computed(() => {
  return Object.entries(props.bigFive).map(([key, value]) => ({
    key: key as keyof BigFiveData,
    label: bigFiveLabels[key as keyof BigFiveData],
    value: typeof value === 'number' ? value : 5,
    percent: Math.round((typeof value === 'number' ? value : 5) * 10),
  }))
})

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

const padBars = computed(() => {
  return Object.entries(props.pad).map(([key, value]) => ({
    key: key as keyof PADData,
    label: padLabels[key as keyof PADData],
    value: typeof value === 'number' ? value : 0.5,
    percent: Math.round((typeof value === 'number' ? value : 0.5) * 100),
  }))
})
</script>

<template>
  <div
    ref="panelRef"
    class="personality-panel"
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
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"
            />
          </svg>
        </div>
        <span class="header-title">人格数据</span>
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
        <div class="header-status">
          <span class="status-dot"></span>
        </div>
      </div>
    </div>

    <div class="detail-content">
      <div class="section">
        <div class="section-title">Big Five</div>
        <div class="bar-list">
          <div v-for="bar in bigFiveBars" :key="bar.key" class="bar-item">
            <span class="bar-label">{{ bar.label }}</span>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: bar.percent + '%' }"></div>
            </div>
            <span class="bar-value">{{ bar.percent }}</span>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">PAD 情感维度</div>
        <div class="bar-list">
          <div v-for="bar in padBars" :key="bar.key" class="bar-item">
            <span class="bar-label">{{ bar.label }}</span>
            <div class="bar-track">
              <div class="bar-fill pad" :style="{ width: bar.percent + '%' }"></div>
            </div>
            <span class="bar-value">{{ bar.percent }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.personality-panel {
  position: fixed;
  pointer-events: auto;
  width: 170px;
  max-height: 40px;
  background: linear-gradient(135deg, rgba(10, 10, 26, 0.85) 0%, rgba(20, 20, 45, 0.9) 100%);
  border: 1px solid rgba(0, 212, 255, 0.35);
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
    0 0 30px rgba(0, 212, 255, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  overflow: hidden;
  z-index: 101;
}

.personality-panel:hover {
  z-index: 201;
}

.personality-panel.breathing:not(.expanded) {
  animation: breathe 3s ease-in-out infinite;
  animation-delay: 2s;
}

.personality-panel.expanded {
  width: 300px;
  max-height: 300px;
  border-color: rgba(0, 212, 255, 0.6);
  box-shadow:
    0 6px 30px rgba(0, 0, 0, 0.5),
    0 0 40px rgba(0, 212, 255, 0.15);
  transition:
    width 0.2s ease,
    max-height 0.4s ease 0.4s,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    left 0.5s ease,
    top 0.5s ease;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}

@keyframes breathe {
  0%,
  100% {
    transform: translateY(0) translateX(var(--panel-offset-x, 0))
      translate(var(--panel-drag-offset-x, 0), var(--panel-drag-offset-y, 0));
  }
  25% {
    transform: translateY(-4px) translateX(var(--panel-offset-x, 0))
      translate(var(--panel-drag-offset-x, 0), var(--panel-drag-offset-y, 0));
  }
  50% {
    transform: translateY(-6px) translateX(var(--panel-offset-x, 0))
      translate(var(--panel-drag-offset-x, 0), var(--panel-drag-offset-y, 0));
  }
  75% {
    transform: translateY(-4px) translateX(var(--panel-offset-x, 0))
      translate(var(--panel-drag-offset-x, 0), var(--panel-drag-offset-y, 0));
  }
}

.panel-corner {
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: #00d4ff;
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
  background: linear-gradient(90deg, transparent, rgba(236, 72, 153, 0.5), transparent);
  animation: scan 4s linear infinite;
  opacity: 0.35;
  animation-delay: -1.5s;
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

.personality-panel.expanded .panel-header {
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 212, 255, 0.15);
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
  color: #00d4ff;
  filter: drop-shadow(0 0 3px rgba(0, 212, 255, 0.5));
  flex-shrink: 0;
}

.header-icon {
  width: 14px;
  height: 14px;
  color: #00d4ff;
  opacity: 0.8;
}

.header-title {
  font-size: 11px;
  font-weight: 600;
  color: #00d4ff;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.lock-icon {
  width: 14px;
  height: 14px;
  color: #00d4ff;
  filter: drop-shadow(0 0 4px rgba(0, 212, 255, 0.8));
  flex-shrink: 0;
}

.header-status {
  display: flex;
  align-items: center;
  align-self: center;
}

.status-dot {
  width: 6px;
  height: 6px;
  background: #00ff88;
  border-radius: 50%;
  box-shadow: 0 0 8px #00ff88;
  animation: pulse 2s ease-in-out infinite;
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

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    max-height 0.3s ease,
    opacity 0.3s ease,
    gap 0.3s ease;
}

.personality-panel.expanded .detail-content {
  gap: 12px;
  max-height: 260px;
  opacity: 1;
}

.section-title {
  font-size: 9px;
  color: rgba(0, 212, 255, 0.7);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 6px;
}

.bar-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bar-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar-item .bar-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.65);
  width: 50px;
  flex-shrink: 0;
}

.bar-item .bar-track {
  flex: 1;
  height: 4px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  overflow: hidden;
}

.bar-item .bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #00d4ff, #00ffff);
  border-radius: 2px;
  transition: width 0.5s ease;
  box-shadow: 0 0 6px rgba(0, 212, 255, 0.4);
}

.bar-item .bar-fill.pad {
  background: linear-gradient(90deg, #a78bfa, #c4b5fd);
  box-shadow: 0 0 6px rgba(167, 139, 250, 0.4);
}

.bar-item .bar-value {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  width: 24px;
  text-align: right;
}
</style>
