<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import markdownit from 'markdown-it'

const md = markdownit({ html: true, breaks: true })

interface Props {
  content: string
  id: string
  /** 自动展开的消息ID，当等于当前消息ID时自动展开 */
  autoExpandedId?: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** 用户手动切换展开状态时触发 */
  (e: 'userToggle'): void
}>()

/** 用户是否手动操作过展开/收起 */
const userToggled = ref(false)

const collapsedThinks = ref<Set<string>>(new Set())

const toggleThink = (thinkId: string) => {
  userToggled.value = true
  emit('userToggle')
  if (collapsedThinks.value.has(thinkId)) {
    collapsedThinks.value.delete(thinkId)
  } else {
    collapsedThinks.value.add(thinkId)
  }
}

const isThinkExpanded = (thinkId: string) => {
  // 如果是最后一条消息且用户未操作过，自动展开
  if (!userToggled.value && props.autoExpandedId === props.id) {
    return true
  }
  return collapsedThinks.value.has(thinkId)
}

const tryParseJson = (
  content: string,
): { tts?: string; commands?: Array<{ type: string; text?: string }> } | null => {
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const ttsCmd = parsed.find((cmd: any) => cmd.type === 'tts' && cmd.text)
      if (ttsCmd) {
        return { tts: ttsCmd.text, commands: parsed }
      }
    }
    if (parsed && typeof parsed === 'object') {
      if (parsed.tts) {
        return parsed
      }
      if (parsed.output && Array.isArray(parsed.output)) {
        const ttsCmd = parsed.output.find((cmd: any) => cmd.type === 'tts' && cmd.text)
        if (ttsCmd) {
          return { tts: ttsCmd.text, commands: parsed.output }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

const parseThinkTags = (content: string): { thinkContent: string | null; mainContent: string } => {
  const thinkRegex = /<think\s*>([\s\S]*?)<\/think>/gi
  const matches = [...content.matchAll(thinkRegex)]

  if (matches.length === 0) {
    return { thinkContent: null, mainContent: content }
  }

  const thinkContent = matches.map((m) => m[1].trim()).join('\n')
  const mainContent = content.replace(thinkRegex, '').trim()

  return { thinkContent, mainContent }
}

const normalizeNewlines = (content: string): string => {
  return content.replace(/\\n/g, '\n')
}

const renderMarkdown = (content: string): string => {
  return md.render(normalizeNewlines(content))
}

const parsedData = computed(() => {
  const parsed = tryParseJson(props.content)
  const rawContent = parsed?.tts || props.content
  const { thinkContent, mainContent } = parseThinkTags(rawContent)
  return { thinkContent, mainContent, hasTts: !!parsed?.tts }
})

onMounted(() => {})
</script>

<template>
  <div class="message-content-wrapper">
    <div
      v-if="parsedData.thinkContent"
      :class="['thinking-node', isThinkExpanded(id) ? 'expanded' : '']"
    >
      <div class="thinking-header" @click="toggleThink(id)">
        <svg class="thinking-icon" viewBox="0 0 24 24">
          <path
            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
          />
        </svg>
        <span class="thinking-title">思考过程</span>
        <svg
          :class="['thinking-toggle', isThinkExpanded(id) ? 'expanded' : '']"
          viewBox="0 0 24 24"
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </div>
      <div class="thinking-body">
        <div class="thinking-chain">
          <div class="thinking-step active">
            <div class="step-marker">1</div>
            <div class="step-content">
              <!-- think 内容原样显示，不做 markdown 解析 -->
              <div class="think-plain-text">{{ parsedData.thinkContent }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="main-content">
      <div class="msg-markdown-content" v-html="renderMarkdown(parsedData.mainContent)"></div>
    </div>
  </div>
</template>

<style scoped>
.message-content-wrapper {
  max-width: 100%;
}

.main-content {
  word-break: break-word;
}

.main-content :deep(p) {
  margin: 6px 0;
}

.main-content :deep(p:last-child) {
  margin-bottom: 0;
}

.main-content :deep(h1),
.main-content :deep(h2),
.main-content :deep(h3) {
  color: #00ffff;
  margin: 8px 0 4px 0;
}

.main-content :deep(h1) {
  font-size: 16px;
}

.main-content :deep(h2) {
  font-size: 14px;
}

.main-content :deep(h3) {
  font-size: 13px;
}

.main-content :deep(code) {
  background: rgba(0, 212, 255, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  color: #00ffff;
}

.main-content :deep(pre) {
  background: rgba(0, 20, 40, 0.8);
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  border: 1px solid rgba(0, 212, 255, 0.3);
  margin: 8px 0;
}

.main-content :deep(pre code) {
  background: none;
  padding: 0;
  color: #a0e0ff;
}

.main-content :deep(ul),
.main-content :deep(ol) {
  margin: 6px 0;
  padding-left: 18px;
}

.main-content :deep(li) {
  margin: 3px 0;
}

.main-content :deep(strong) {
  color: #00ffff;
}

.main-content :deep(a) {
  color: #00d4ff;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s;
}

.main-content :deep(a:hover) {
  border-bottom-color: #00ffff;
}

.thinking-node {
  background: linear-gradient(135deg, rgba(120, 80, 200, 0.12) 0%, rgba(80, 60, 150, 0.08) 100%);
  border: 1px solid rgba(138, 100, 220, 0.3);
  border-radius: 8px;
  margin: 10px 0;
  overflow: hidden;
  position: relative;
  transition: all 0.3s ease;
}

.thinking-node:hover {
  border-color: rgba(138, 100, 220, 0.5);
  box-shadow: 0 0 25px rgba(138, 100, 220, 0.2);
}

.thinking-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  cursor: pointer;
  background: rgba(138, 100, 220, 0.08);
  transition: background 0.2s;
}

.thinking-header:hover {
  background: rgba(138, 100, 220, 0.15);
}

.thinking-icon {
  width: 18px;
  height: 18px;
  margin-right: 8px;
  fill: #a080e0;
  animation: thinkPulse 2s ease-in-out infinite;
}

@keyframes thinkPulse {
  0%,
  100% {
    opacity: 0.7;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.05);
  }
}

.thinking-title {
  flex: 1;
  color: #c8a8f0;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 1px;
}

.thinking-toggle {
  width: 14px;
  height: 14px;
  fill: #a080e0;
  transition: transform 0.3s;
}

.thinking-toggle.expanded {
  transform: rotate(180deg);
}

.thinking-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.5s ease;
}

.thinking-node.expanded .thinking-body {
  max-height: 800px;
}

.thinking-chain {
  padding: 12px;
  position: relative;
}

.thinking-step {
  position: relative;
  padding-left: 30px;
  padding-bottom: 12px;
  opacity: 0;
  animation: stepAppear 0.4s ease forwards;
}

@keyframes stepAppear {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.thinking-step:last-child {
  padding-bottom: 0;
}

.thinking-step::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 22px;
  bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, rgba(138, 100, 220, 0.6) 0%, rgba(138, 100, 220, 0.2) 100%);
  border-radius: 1px;
}

.thinking-step:last-child::before {
  display: none;
}

.step-marker {
  position: absolute;
  left: 0;
  top: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(138, 100, 220, 0.4), rgba(100, 70, 180, 0.3));
  border: 2px solid rgba(138, 100, 220, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: #d4b8ff;
  font-weight: 600;
  box-shadow: 0 0 10px rgba(138, 100, 220, 0.4);
}

.thinking-step.active .step-marker {
  background: linear-gradient(135deg, #a080e0, #8060c0);
  border-color: #c8a8f0;
  box-shadow: 0 0 15px rgba(138, 100, 220, 0.6);
  animation: markerPulse 1s ease-in-out infinite;
}

@keyframes markerPulse {
  0%,
  100% {
    box-shadow: 0 0 15px rgba(138, 100, 220, 0.6);
  }
  50% {
    box-shadow: 0 0 25px rgba(138, 100, 220, 0.9);
  }
}

.step-content {
  color: #d0c0e8;
  font-size: 12px;
  line-height: 1.5;
}

.step-content :deep(code) {
  background: rgba(138, 100, 220, 0.2);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: 'Consolas', monospace;
  font-size: 11px;
  color: #c8a8f0;
}
</style>
