# OpenClaw 项目分析报告

## 概述

本报告分析 OpenClaw 项目中关于**摘要生成**、**上下文压缩**、**上下文上限处理**和 **TTS（语音合成）标记**的实现机制。

---

## 1. 摘要功能实现

### 1.1 摘要触发时机

摘要（Summary）是在**上下文压缩（Compaction）**过程中触发的。压缩可以在以下时机被触发：

**触发类型（trigger）定义在 `compact.types.ts`：**
```typescript
trigger?: "budget" | "overflow" | "manual";
```

- **`budget`**：当上下文接近预算上限时自动触发
- **`overflow`**：当上下文溢出时触发
- **`manual`**：手动触发压缩

** preemptive-compaction.ts 中的预检查逻辑：**
```typescript
export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  overflowTokens: number;
}
```

### 1.2 摘要记录的内容

**`compaction.ts` 中的摘要指令定义：**

```typescript
const MERGE_SUMMARIES_INSTRUCTIONS = [
  "Merge these partial summaries into a single cohesive summary.",
  "",
  "MUST PRESERVE:",
  "- Active tasks and their current status (in-progress, blocked, pending)",
  "- Batch operation progress (e.g., '5/17 items completed')",
  "- The last thing the user requested and what was being done about it",
  "- Decisions made and their rationale",
  "- TODOs, open questions, and constraints",
  "- Any commitments or follow-ups promised",
  "",
  "PRIORITIZE recent context over older history. The agent needs to know",
  "what it was doing, not just what was discussed.",
].join("\n");
```

**【中文翻译】**
```
将这些部分摘要合并成一个连贯的摘要。

必须保留：
- 活动任务及其当前状态（进行中、阻塞、待处理）
- 批量操作进度（例如：'已完成 5/17 项'）
- 用户最后请求的内容以及正在处理的事项
- 已做出的决策及其依据
- TODOs、开放问题和约束条件
- 任何承诺或后续跟进事项

优先重视近期上下文而非历史记录。智能体需要知道
它正在做什么，而不仅仅是讨论过什么。
```

**标识符保护指令：**
```typescript
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";
```

**【中文翻译】**
```
完全按原样保留所有不透明标识符（不得缩短或重构），
包括 UUID、哈希值、ID、主机名、IP、端口、URL 和文件名。
```

**默认压缩指令（`compaction-instructions.ts`）：**
```typescript
export const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";
```

**【中文翻译】**
```
使用对话中使用的主要语言编写摘要正文。
关注事实性内容：讨论了什么、做出了什么决策以及当前状态。
保持必需的摘要结构和章节标题不变。
不要翻译或修改代码、文件路径、标识符或错误消息。
```

### 1.3 摘要存储位置

摘要结果存储在压缩结果中，并持久化到检查点（checkpoint）：

**`compact.ts` 中的检查点存储：**
```typescript
const storedCheckpoint = await persistSessionCompactionCheckpoint({
  cfg: params.config,
  sessionKey: params.sessionKey,
  sessionId: activeSessionId,
  reason: resolveSessionCompactionCheckpointReason({
    trigger: params.trigger,
  }),
  snapshot: checkpointSnapshot,
  summary: result.summary,  // <-- 摘要存储在这里
  firstKeptEntryId: effectiveFirstKeptEntryId,
  tokensBefore: observedTokenCount ?? result.tokensBefore,
  tokensAfter,
  postSessionFile: activeSessionFile,
  postLeafId: activePostLeafId,
  postEntryId: activePostLeafId,
  createdAt: compactStartedAt,
});
```

### 1.4 摘要注入回上下文的时机

摘要在压缩完成后立即注入回会话：

**`compact.ts` 中的核心压缩调用：**
```typescript
const result = await compactWithSafetyTimeout(
  () => {
    setCompactionSafeguardCancelReason(compactionSessionManager, undefined);
    return activeSession.compact(params.customInstructions);
  },
  compactionTimeoutMs,
  {
    abortSignal: params.abortSignal,
    onCancel: () => {
      activeSession.abortCompaction();
    },
  },
);
```

压缩后的摘要将作为系统消息或摘要消息保留在会话历史中。

---

## 2. 压缩功能实现

### 2.1 压缩时如何处理上下文中的消息

**分块策略（`compaction.ts`）：**

```typescript
export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  // 按token份额分割消息
  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  
  // 保持工具调用/结果配对完整性
  let pendingToolCallIds = new Set<string>();
  let pendingChunkStartIndex: number | null = null;
  
  // 分割逻辑...
}
```

**消息修剪策略（`pruneHistoryForContextShare`）：**
```typescript
export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
}
```

### 2.2 压缩的安全措施

**工具结果详情剥离（安全考虑）：**
```typescript
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details and runtime-context transcript entries must never enter LLM-facing compaction.
  const safe = stripToolResultDetails(stripRuntimeContextCustomMessages(messages));
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}
```

**【中文翻译】安全注释：**
```
安全注意：toolResult.details 和运行时上下文转录条目绝不能进入面向 LLM 的压缩流程。
```

**工具使用/结果配对修复：**
```typescript
// After dropping a chunk, repair tool_use/tool_result pairing to handle
// orphaned tool_results (whose tool_use was in the dropped chunk).
// repairToolUseResultPairing drops orphaned tool_results, preventing
// "unexpected tool_use_id" errors from Anthropic's API.
const repairReport = repairToolUseResultPairing(flatRest);
```

**【中文翻译】注释：**
```
在丢弃一个块后，修复 tool_use/tool_result 配对以处理
孤立的 tool_results（其 tool_use 在被丢弃的块中）。
repairToolUseResultPairing 会丢弃孤立的 tool_results，防止
来自 Anthropic API 的 "unexpected tool_use_id" 错误。
```

### 2.3 压缩的历史限制

**`history.ts` 中的历史限制：**
```typescript
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}
```

---

## 3. 上下文临近上限的处理机制

### 3.1 上下文窗口保护

**`context-window-guard.ts` 中的保护常量：**
```typescript
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;
```

**上下文窗口解析：**
```typescript
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextTokens?: number;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  // 优先级：modelsConfig -> model -> default
  const fromModelsConfig = // ...
  const fromModel = // ...
  
  // 应用 agents.defaults.contextTokens 上限
  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }
  
  return baseInfo;
}
```

### 3.2 预留Token策略

**`pi-compaction-constants.ts`：**
```typescript
/**
 * Absolute minimum prompt budget in tokens.
 */
export const MIN_PROMPT_BUDGET_TOKENS = 8_000;

/**
 * Minimum share of the context window that must remain available for prompt
 * content after reserve tokens are subtracted.
 */
export const MIN_PROMPT_BUDGET_RATIO = 0.5;
```

**【中文翻译】注释：**
```
/**
 * 以 token 为单位的绝对最小提示预算。
 */

/**
 * 在预留 token 被减去后，必须保持可用于提示内容的
 * 上下文窗口的最小比例。
 */
```

**`pi-settings.ts` 中的预留Token计算：**
```typescript
export function applyPiCompactionSettingsFromConfig(params: {
  settingsManager: PiSettingsManagerLike;
  cfg?: OpenClawConfig;
  contextTokenBudget?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  // Cap the floor to a safe fraction of the context window so that
  // small-context models (e.g. Ollama with 16 K tokens) are not starved of
  // prompt budget.
  const ctxBudget = params.contextTokenBudget;
  if (typeof ctxBudget === "number" && Number.isFinite(ctxBudget) && ctxBudget > 0) {
    const minPromptBudget = Math.min(
      MIN_PROMPT_BUDGET_TOKENS,
      Math.max(1, Math.floor(ctxBudget * MIN_PROMPT_BUDGET_RATIO)),
    );
    const maxReserve = Math.max(0, ctxBudget - minPromptBudget);
    reserveTokensFloor = Math.min(reserveTokensFloor, maxReserve);
  }
  // ...
}
```

**【中文翻译】注释：**
```
将下限限制为上下文窗口的安全比例，以确保
小上下文模型（例如 16K token 的 Ollama）不会缺乏
提示预算。
```

### 3.3 预emptive压缩决策

**`preemptive-compaction.ts` 中的路由决策：**
```typescript
export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  route: PreemptiveCompactionRoute;  // "fits" | "compact_only" | "truncate_tool_results_only" | "compact_then_truncate"
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
}
```

**路由逻辑：**
- **`fits`**：上下文足够，无需压缩
- **`compact_only`**：仅需要压缩（工具结果无缩减空间）
- **`truncate_tool_results_only`**：仅截断工具结果即可满足
- **`compact_then_truncate`**：先压缩，再截断工具结果

### 3.4 压缩超时处理

**`compaction-timeout.ts`：**
```typescript
export function resolveRunTimeoutDuringCompaction(params: {
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
  graceAlreadyUsed: boolean;
}): "extend" | "abort" {
  if (!params.isCompactionPendingOrRetrying && !params.isCompactionInFlight) {
    return "abort";
  }
  return params.graceAlreadyUsed ? "abort" : "extend";
}
```

---

## 4. TTS（语音合成）标记

### 4.1 TTS 系统提示注入

**`speech-core/src/tts.ts` 中的 `buildTtsSystemPromptHint` 函数：**
```typescript
export function buildTtsSystemPromptHint(
  cfg: OpenClawConfig,
  agentId?: string,
): string | undefined {
  cfg = resolveTtsRuntimeConfig(cfg);
  const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({ cfg, agentId });
  if (autoMode === "off") {
    return undefined;
  }
  
  const _config = resolveTtsConfig(cfg, agentId);
  const persona = getTtsPersona(_config, prefsPath);
  const maxLength = getTtsMaxLength(prefsPath);
  const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
  
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : autoMode === "tagged"
        ? "Only use TTS when you include [[tts:key=value]] directives or a [[tts:text]]...[[/tts:text]] block."
        : undefined;
        
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    persona
      ? `Active TTS persona: ${persona.label ?? persona.id}${persona.description ? ` - ${persona.description}` : ""}.`
      : undefined,
    `Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}
```

**【中文翻译】TTS 系统提示内容：**
```
语音 (TTS) 已启用。

[自动模式提示]
- inbound 模式：仅在用户最后一条消息包含音频/语音时使用 TTS。
- tagged 模式：仅在你包含 [[tts:key=value]] 指令或 [[tts:text]]...[[/tts:text]] 块时使用 TTS。

[角色提示]
当前 TTS 角色：{角色名称} - {角色描述}。

[长度限制]
保持语音文本 ≤{最大长度} 字符以避免自动摘要（摘要功能：开启/关闭）。

[使用说明]
使用 [[tts:...]] 和可选的 [[tts:text]]...[[/tts:text]] 来控制语音/表现力。
```

### 4.2 TTS 提示注入系统提示

**`system-prompt.ts` 中的 Voice Section：**
```typescript
function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## Voice (TTS)", hint, ""];
}
```

**【中文翻译】系统提示中的语音章节：**
```
## 语音 (TTS)
[注入的 TTS 提示内容]
```

### 4.3 TTS 工具实现

**`tts-tool.ts`：**
```typescript
export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentId?: string;
  agentAccountId?: string;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    displaySummary: "Convert text to speech and return audio.",
    description: `Convert text to speech. Audio is delivered automatically from the tool result — reply with ${SILENT_REPLY_TOKEN} after a successful call to avoid duplicate messages.`,
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const text = readStringParam(params, "text", { required: true });
      const result = await textToSpeech({
        text,
        cfg,
        channel: channel ?? opts?.agentChannel,
        agentId: opts?.agentId,
        accountId: opts?.agentAccountId,
      });

      if (result.success && result.audioPath) {
        return {
          content: [{ type: "text", text: `(spoken) ${sanitizeTranscriptForToolContent(text)}` }],
          details: {
            audioPath: result.audioPath,
            provider: result.provider,
            media: {
              mediaUrl: result.audioPath,
              trustedLocalMedia: true,
              ...(result.audioAsVoice || result.voiceCompatible ? { audioAsVoice: true } : {}),
            },
          },
        };
      }
      throw new Error(result.error ?? "TTS conversion failed");
    },
  };
}
```

**【中文翻译】TTS 工具描述：**
```
标签：TTS
名称：tts
显示摘要：将文本转换为语音并返回音频。
描述：将文本转换为语音。音频会自动从工具结果中传递——成功调用后回复 
      <SILENT_REPLY_TOKEN> 以避免重复消息。

执行成功返回：
- 内容：(spoken) [已净化的文本内容]
- 详情：
  - audioPath: 音频文件路径
  - provider: 提供商
  - media: 
    - mediaUrl: 媒体URL
    - trustedLocalMedia: true（可信本地媒体）
    - audioAsVoice: true（如果是语音消息）
```

### 4.4 TTS 标记格式

AI 可以使用以下标记控制 TTS：

1. **`[[tts:key=value]]`** - 设置 TTS 参数
2. **`[[tts:text]]...[[/tts:text]]`** - 标记需要语音合成的文本块

**自动模式（autoMode）：**
- **`off`**：TTS 禁用
- **`inbound`**：仅在用户消息包含音频/语音时使用 TTS
- **`tagged`**：仅在包含 TTS 标记时使用 TTS

---

## 5. 关键文件索引

| 功能 | 文件路径 |
|------|----------|
| 核心压缩逻辑 | `src/agents/pi-embedded-runner/compact.ts` |
| 压缩类型定义 | `src/agents/pi-embedded-runner/compact.types.ts` |
| 摘要生成 | `src/agents/compaction.ts` |
| 压缩指令 | `src/agents/pi-hooks/compaction-instructions.ts` |
| 压缩钩子 | `src/agents/pi-embedded-runner/compaction-hooks.ts` |
| 上下文窗口保护 | `src/agents/context-window-guard.ts` |
| 压缩常量 | `src/agents/pi-compaction-constants.ts` |
| 压缩设置 | `src/agents/pi-settings.ts` |
| 预emptive压缩 | `src/agents/pi-embedded-runner/run/preemptive-compaction.ts` |
| 压缩超时 | `src/agents/pi-embedded-runner/run/compaction-timeout.ts` |
| 历史限制 | `src/agents/pi-embedded-runner/history.ts` |
| TTS 核心 | `extensions/speech-core/src/tts.ts` |
| TTS 工具 | `src/agents/tools/tts-tool.ts` |
| 系统提示构建 | `src/agents/system-prompt.ts` |
| 嵌入式系统提示 | `src/agents/pi-embedded-runner/system-prompt.ts` |

---

## 6. 总结

OpenClaw 的上下文管理机制具有以下特点：

1. **多层防护**：通过预检查、自动压缩、工具结果截断等多层机制防止上下文溢出

2. **智能摘要**：在压缩时保留关键信息（任务状态、决策、TODO等），并支持多阶段摘要合并

3. **安全第一**：严格剥离 toolResult.details 等敏感信息，防止进入 LLM 摘要流程

4. **灵活配置**：支持多种触发模式（budget/overflow/manual）和可配置的预留Token策略

5. **TTS 集成**：通过系统提示注入 TTS 能力，支持标记控制和自动模式
