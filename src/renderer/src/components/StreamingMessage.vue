<script setup lang="ts">
/**
 * 流式消息组件
 * 用于显示正在流式传输中的消息（打字机效果）
 * 流式过程中不做 markdown 解析，完成后由 MessageBubble 接管
 */

interface Props {
  /** 消息内容 */
  content: string
  /** 消息ID */
  id: string
}

defineProps<Props>()
</script>

<template>
  <div class="streaming-message">
    <span class="streaming-content">{{ content }}</span>
    <span class="streaming-cursor"></span>
  </div>
</template>

<style scoped>
.streaming-message {
  color: #e0f7ff;
  line-height: 1.6;
  font-size: 13px;
  padding: 10px 12px;
  background: rgba(0, 150, 200, 0.1);
  border-left: 2px solid #00d4ff;
  border-radius: 0 6px 6px 0;
  box-shadow: inset 0 0 20px rgba(0, 212, 255, 0.03);
  word-break: break-word;
  white-space: pre-wrap;
}

.streaming-content {
  /* 纯文本显示，保持原样 */
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  background: #00d4ff;
  animation: blink 1s infinite;
  margin-left: 2px;
  vertical-align: middle;
}

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}
</style>
