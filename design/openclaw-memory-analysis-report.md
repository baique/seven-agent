# OpenClaw 记忆系统分析报告

## 概述

本报告分析 OpenClaw 项目中关于**记忆存储**、**向量检索**、**混合搜索**、**工具设计**和**提示词指导**的实现机制。

---

## 1. 记忆存储机制（SQLite）

### 1.1 数据库初始化

**`manager-db.ts` - 数据库打开：**
```typescript
import type { DatabaseSync } from "node:sqlite";

export function openMemoryDatabaseAtPath(dbPath: string, allowExtension: boolean): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension });
  configureMemorySqliteWalMaintenance(db);
  // 设置忙等待超时，避免并发冲突
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
```

### 1.2 表结构

**核心表（`manager.ts` 常量定义）：**
```typescript
const VECTOR_TABLE = "chunks_vec";      // 向量表（sqlite-vec扩展）
const FTS_TABLE = "chunks_fts";         // 全文搜索表（FTS5）
const EMBEDDING_CACHE_TABLE = "embedding_cache";  // 嵌入缓存表
```

**chunks 表结构（从 SQL 推断）：**
```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT,           -- 记忆文件路径
  start_line INTEGER,  -- 起始行号
  end_line INTEGER,    -- 结束行号
  text TEXT,           -- 文本内容
  source TEXT,         -- 来源（memory/sessions）
  model TEXT           -- 嵌入模型名称
);
```

**chunks_vec 向量表（sqlite-vec）：**
```sql
-- 使用 sqlite-vec 扩展创建向量表
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  embedding FLOAT[]    -- 向量维度由模型决定
);
```

**chunks_fts 全文搜索表（FTS5）：**
```sql
-- 使用 FTS5 扩展创建全文搜索表
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content='chunks',    -- 关联到 chunks 表
  content_rowid='id'
);
```

### 1.3 数据写入流程

**向量化存储（`manager-vector-write.ts`）：**
```typescript
// 1. 分块处理记忆文件
const chunks = chunkDocument(content, {
  tokens: config.chunking.tokens,      // 默认 400 tokens
  overlap: config.chunking.overlap,    // 默认 80 tokens
});

// 2. 生成嵌入向量
const embeddings = await provider.embedBatch(chunks.map(c => c.text));

// 3. 写入 chunks 表
db.prepare(`
  INSERT INTO chunks (id, path, start_line, end_line, text, source, model)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(id, path, startLine, endLine, text, source, model);

// 4. 写入向量表
const vecBlob = Buffer.from(new Float32Array(embedding).buffer);
db.prepare(`
  INSERT INTO ${vectorTable} (id, embedding)
  VALUES (?, ?)
`).run(id, vecBlob);
```

---

## 2. 本地向量库加载

### 2.1 向量扩展加载

**`manager.ts` - 向量扩展配置：**
```typescript
protected readonly vector: {
  enabled: boolean;
  available: boolean | null;
  extensionPath?: string;    // sqlite-vec 扩展路径
  loadError?: string;
  dims?: number;             // 向量维度
};

// 加载 sqlite-vec 扩展
private async loadVectorExtension(): Promise<boolean> {
  if (!this.vector.enabled) return false;
  
  try {
    const extPath = this.vector.extensionPath || findDefaultVecExtension();
    this.db.loadExtension(extPath);
    this.vector.available = true;
    
    // 验证向量维度
    const dims = await this.probeVectorDimensions();
    this.vector.dims = dims;
    return true;
  } catch (err) {
    this.vector.available = false;
    this.vector.loadError = String(err);
    return false;
  }
}
```

### 2.2 本地嵌入模型

**`embeddings.ts` - 本地模型配置：**
```typescript
export const DEFAULT_LOCAL_MODEL = "nomic-embed-text";

export interface LocalEmbeddingConfig {
  modelPath?: string;       // 本地模型路径
  modelCacheDir?: string;   // 模型缓存目录
  contextSize?: number | "auto";  // 上下文大小
}

// 创建本地嵌入提供者
export async function createLocalEmbeddingProvider(
  config: LocalEmbeddingConfig
): Promise<EmbeddingProvider> {
  const model = await loadLocalEmbeddingModel({
    modelPath: config.modelPath,
    cacheDir: config.modelCacheDir,
  });
  
  return {
    id: "local",
    model: config.modelPath || DEFAULT_LOCAL_MODEL,
    embedQuery: async (text: string) => {
      return model.embed(text);
    },
    embedBatch: async (texts: string[]) => {
      return model.embedBatch(texts);
    },
  };
}
```

### 2.3 嵌入提供者优先级

**`embeddings.ts` - 提供者选择：**
```typescript
export async function createEmbeddingProvider(params: {
  config: OpenClawConfig;
  agentDir: string;
  provider?: string;        // "auto" | "openai" | "local" | ...
  model?: string;
}): Promise<EmbeddingProviderResult> {
  // 1. 如果指定了具体提供者，直接使用
  if (params.provider && params.provider !== "auto") {
    return await createSpecificProvider(params);
  }
  
  // 2. auto 模式：尝试本地模型
  if (await canAutoSelectLocal(params.config)) {
    return await createLocalEmbeddingProvider(params);
  }
  
  // 3. 回退到远程提供者
  return await createRemoteEmbeddingProvider(params);
}
```

---

## 3. 混合记忆检索实现

### 3.1 混合搜索架构

**`hybrid.ts` - 混合搜索核心：**
```typescript
export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];      // 向量搜索结果
  keyword: HybridKeywordResult[];    // 关键词搜索结果
  vectorWeight: number;              // 向量权重（默认 0.7）
  textWeight: number;                // 文本权重（默认 0.3）
  mmr?: Partial<MMRConfig>;          // MMR 多样性配置
  temporalDecay?: Partial<TemporalDecayConfig>;  // 时间衰减
}): Promise<HybridMergedResult[]> {
  // 1. 按 ID 合并结果
  const byId = new Map<string, MergedResult>();
  
  // 添加向量结果
  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      vectorScore: r.vectorScore,
      textScore: 0,
      snippet: r.snippet,
      // ...
    });
  }
  
  // 添加/合并关键词结果
  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
    } else {
      byId.set(r.id, {
        id: r.id,
        vectorScore: 0,
        textScore: r.textScore,
        snippet: r.snippet,
        // ...
      });
    }
  }
  
  // 2. 计算加权分数
  const merged = Array.from(byId.values()).map(entry => {
    const score = params.vectorWeight * entry.vectorScore 
                + params.textWeight * entry.textScore;
    return { ...entry, score };
  });
  
  // 3. 应用时间衰减
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: params.temporalDecay,
  });
  
  // 4. 应用 MMR 重排序（可选）
  if (params.mmr?.enabled) {
    return applyMMRToHybridResults(decayed, params.mmr);
  }
  
  return decayed.sort((a, b) => b.score - a.score);
}
```

### 3.2 向量搜索（KNN）

**`manager-search.ts` - 向量搜索：**
```typescript
export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  queryVec: number[];           // 查询向量
  limit: number;
  sourceFilterVec: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  const qBlob = vectorToBlob(params.queryVec);
  
  // 使用 sqlite-vec 的 KNN 搜索
  const rows = params.db
    .prepare(`
      SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
             vec_distance_cosine(v.embedding, ?) AS dist
      FROM ${params.vectorTable} v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ? AND k = ? AND c.model = ?${params.sourceFilterVec.sql}
      ORDER BY dist ASC
      LIMIT ?
    `)
    .all(qBlob, qBlob, candidateLimit, providerModel, ...params.sourceFilterVec.params, params.limit)
    as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      dist: number;
    }>;
  
  return rows.map(row => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    score: 1 - row.dist,  // 距离转相似度
    snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
    source: row.source,
  }));
}
```

### 3.3 关键词搜索（BM25）

**`manager-search.ts` - FTS5 搜索：**
```typescript
export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  limit: number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  // 构建 FTS5 查询
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map(t => t.trim()) ?? [];
  const matchQuery = tokens.map(t => `"${t.replaceAll('"', "")}"`).join(" AND ");
  
  const rows = params.db
    .prepare(`
      SELECT id, path, source, start_line, end_line, text,
             bm25(${params.ftsTable}) AS rank
      FROM ${params.ftsTable}
      WHERE ${params.ftsTable} MATCH ?${modelClause}${params.sourceFilter.sql}
      ORDER BY rank ASC
      LIMIT ?
    `)
    .all(matchQuery, ...modelParams, ...params.sourceFilter.params, params.limit)
    as Array<{
      id: string;
      path: string;
      source: SearchSource;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;
    }>;
  
  return rows.map(row => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    score: bm25RankToScore(row.rank),  // BM25 排名转分数
    textScore: bm25RankToScore(row.rank),
    snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
    source: row.source,
  }));
}

// BM25 排名转分数
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
```

### 3.4 MMR 多样性重排序

**`mmr.ts` - Maximal Marginal Relevance：**
```typescript
export interface MMRConfig {
  enabled: boolean;
  lambda: number;  // 相关性 vs 多样性的平衡参数（0-1）
}

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,  // 0 = 最大多样性，1 = 最大相关性
};

export function applyMMRToHybridResults(
  results: HybridMergedResult[],
  config: MMRConfig
): HybridMergedResult[] {
  if (!config.enabled || results.length <= 1) return results;
  
  const selected: HybridMergedResult[] = [];
  const remaining = [...results];
  
  while (remaining.length > 0 && selected.length < results.length) {
    let bestMMRScore = -Infinity;
    let bestIndex = 0;
    
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      
      // MMR = λ * Sim(query, doc) - (1-λ) * max(Sim(doc, selected))
      const relevance = candidate.score;
      let maxSimToSelected = 0;
      
      for (const sel of selected) {
        const sim = cosineSimilarity(candidate.embedding, sel.embedding);
        maxSimToSelected = Math.max(maxSimToSelected, sim);
      }
      
      const mmrScore = config.lambda * relevance - (1 - config.lambda) * maxSimToSelected;
      
      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIndex = i;
      }
    }
    
    selected.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }
  
  return selected;
}
```

---

## 4. 记忆返回格式

### 4.1 搜索结果格式

**`hybrid.ts` - 混合搜索结果：**
```typescript
export type HybridMergedResult = {
  path: string;           // 文件路径
  startLine: number;      // 起始行
  endLine: number;        // 结束行
  score: number;          // 综合分数（加权后）
  vectorScore: number;    // 向量相似度
  textScore: number;      // 文本匹配分数
  snippet: string;        // 内容片段（截断后）
  source: HybridSource;   // 来源（memory/sessions）
};
```

### 4.2 工具返回格式

**`memory-state.ts` - 语料库搜索结果：**
```typescript
export type MemoryCorpusSearchResult = {
  corpus: string;         // 语料库名称
  path: string;           // 文件路径
  title?: string;         // 标题
  kind?: string;          // 类型
  score: number;          // 相关度分数
  snippet: string;        // 内容片段
  id?: string;            // 唯一ID
  startLine?: number;     // 起始行
  endLine?: number;       // 结束行
  citation?: string;      // 引用标记
  source?: string;        // 来源
  provenanceLabel?: string;  // 来源标签
  sourceType?: string;    // 来源类型
  sourcePath?: string;    // 来源路径
  updatedAt?: string;     // 更新时间
};

// 获取完整内容的结果
export type MemoryCorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;        // 完整内容
  fromLine: number;       // 起始行
  lineCount: number;      // 行数
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};
```

### 4.3 返回示例

```json
{
  "results": [
    {
      "path": "memory/project-setup.md",
      "startLine": 15,
      "endLine": 25,
      "score": 0.89,
      "vectorScore": 0.92,
      "textScore": 0.75,
      "snippet": "项目使用 TypeScript + Node.js 架构，数据库采用 SQLite...",
      "source": "memory"
    },
    {
      "path": "sessions/2024-01-15.md",
      "startLine": 42,
      "endLine": 55,
      "score": 0.76,
      "vectorScore": 0.81,
      "textScore": 0.65,
      "snippet": "用户要求优化数据库查询性能，建议使用索引...",
      "source": "sessions"
    }
  ]
}
```

---

## 5. 提示词指导

### 5.1 记忆提示词构建

**`memory-state.ts` - 提示词构建器：**
```typescript
export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;  // "on" | "off" | "auto"
}) => string[];

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const primary = normalizeMemoryPromptLines(
    memoryPluginState.capability?.capability.promptBuilder?.(params) ??
      memoryPluginState.promptBuilder?.(params) ??
      []
  );
  
  const supplements = memoryPluginState.promptSupplements
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
    .flatMap((registration) => normalizeMemoryPromptLines(registration.builder(params)));
  
  return [...primary, ...supplements];
}
```

### 5.2 默认记忆提示词

**测试中的示例提示词（`attempt.spawn-workspace.context-engine.test.ts`）：**
```typescript
registerMemoryPromptSection(({ availableTools, citationsMode }) => {
  if (!availableTools.has("memory_search")) {
    return [];
  }
  
  return [
    "## Memory Recall",
    `tools=${[...availableTools].toSorted().join(",")}`,
    `citations=${citationsMode ?? "auto"}`,
    "",
    "Use memory_search to find relevant context from previous conversations.",
    "Prefer tool evidence over recall when action, state, or mutable facts matter.",
    "",
  ];
});
```

### 5.3 系统提示词集成

**`system-prompt.ts` - 记忆章节：**
```typescript
// 记忆章节在上下文文件中的排序
const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],  // 记忆章节
]);

// 构建记忆章节
function buildMemorySection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  const lines = buildMemoryPromptSection(params);
  if (lines.length === 0) return [];
  
  return ["## Memory", ...lines, ""];
}
```

### 5.4 GPT-5 覆盖提示词

**`gpt5-prompt-overlay.ts` - 记忆使用指导：**
```xml
<tool_discipline>
Prefer tool evidence over recall when action, state, or mutable facts matter.
Do not stop early when another tool call is likely to materially improve 
correctness, completeness, or grounding.
Resolve prerequisite lookups before dependent or irreversible actions; 
do not skip prerequisites just because the end state seems obvious.
Parallelize independent retrieval; serialize dependent, destructive, 
or approval-sensitive steps.
</tool_discipline>
```

**【中文翻译】**
```
当涉及动作、状态或可变事实时，优先使用工具证据而非记忆回忆。
如果另一个工具调用可能显著提高正确性、完整性或依据性，不要过早停止。
在执行依赖或不可逆操作之前，先解决前置查询；
不要仅因为最终状态看似明显就跳过前置步骤。
并行化独立的检索操作；序列化依赖、破坏性或对审批敏感的步骤。
```

---

## 6. 记忆检索工具设计

### 6.1 工具注册

**`pi-tools.ts` - 记忆搜索工具：**
```typescript
const SAFE_SEARCH_TOOL_IDS = new Set(["search", "web_search", "memory_search"]);

// 工具分类：只读搜索工具自动批准
export function classifyToolApproval(toolName: string): ApprovalClass {
  if (SAFE_SEARCH_TOOL_IDS.has(toolName)) {
    return { toolName, approvalClass: "readonly_search", autoApprove: true };
  }
  // ...
}
```

### 6.2 记忆搜索工具参数

**从配置推断的工具参数（`memory-search.ts`）：**
```typescript
export type ResolvedMemorySearchConfig = {
  // 查询参数
  query: {
    maxResults: number;           // 最大结果数（默认 6）
    minScore: number;             // 最小分数阈值（默认 0.35）
    hybrid: {
      enabled: boolean;           // 启用混合搜索（默认 true）
      vectorWeight: number;       // 向量权重（默认 0.7）
      textWeight: number;         // 文本权重（默认 0.3）
      candidateMultiplier: number; // 候选倍数（默认 4）
      mmr: {
        enabled: boolean;         // 启用 MMR（默认 false）
        lambda: number;           // MMR 参数（默认 0.7）
      };
      temporalDecay: {
        enabled: boolean;         // 启用时间衰减（默认 false）
        halfLifeDays: number;     // 半衰期天数（默认 30）
      };
    };
  };
  
  // 来源过滤
  sources: Array<"memory" | "sessions">;  // 搜索来源
  
  // 分块配置
  chunking: {
    tokens: number;   // 分块大小（默认 400）
    overlap: number;  // 重叠大小（默认 80）
  };
};
```

### 6.3 工具调用示例

```typescript
// 记忆搜索工具调用
const result = await memorySearchTool.execute({
  query: "如何配置数据库连接",
  maxResults: 5,
  sources: ["memory", "sessions"],
});

// 返回结果
{
  "results": [
    {
      "path": "memory/db-config.md",
      "snippet": "数据库连接配置需要在 .env 文件中设置 DATABASE_URL...",
      "score": 0.92,
      "source": "memory"
    }
  ]
}
```

### 6.4 记忆语料库补充

**`memory-state.ts` - 扩展记忆源：**
```typescript
export type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;
  
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusGetResult | null>;
};

// 注册外部记忆源
export function registerMemoryCorpusSupplement(
  pluginId: string,
  supplement: MemoryCorpusSupplement
): void {
  // 添加到 memoryPluginState.corpusSupplements
}
```

---

## 7. 关键文件索引

| 功能 | 文件路径 |
|------|----------|
| 记忆管理器 | `extensions/memory-core/src/memory/manager.ts` |
| 数据库操作 | `extensions/memory-core/src/memory/manager-db.ts` |
| 向量搜索 | `extensions/memory-core/src/memory/manager-search.ts` |
| 混合搜索 | `extensions/memory-core/src/memory/hybrid.ts` |
| MMR 重排序 | `extensions/memory-core/src/memory/mmr.ts` |
| 时间衰减 | `extensions/memory-core/src/memory/temporal-decay.ts` |
| 嵌入提供者 | `extensions/memory-core/src/memory/embeddings.ts` |
| 记忆状态/提示词 | `src/plugins/memory-state.ts` |
| 记忆搜索配置 | `src/agents/memory-search.ts` |
| 系统提示词 | `src/agents/system-prompt.ts` |

---

## 8. 总结

OpenClaw 的记忆系统具有以下特点：

1. **混合检索**：结合向量相似度（KNN）和全文搜索（BM25），通过加权融合提升召回率

2. **本地优先**：支持本地嵌入模型（nomic-embed-text），使用 sqlite-vec 扩展实现本地向量存储

3. **多样性优化**：支持 MMR（Maximal Marginal Relevance）重排序，平衡相关性和多样性

4. **时间感知**：支持时间衰减，让近期记忆获得更高权重

5. **插件化架构**：通过 `MemoryCorpusSupplement` 支持扩展外部记忆源

6. **提示词指导**：在系统提示词中明确指导 AI 何时使用记忆搜索，何时优先工具证据
