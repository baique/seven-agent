/**
 * HybridSearch - 混合检索模块
 * 结合向量相似度（KNN）和全文搜索（BM25），支持 MMR 多样性和时间衰减
 */

import Database from 'better-sqlite3'
import type {
  HybridSearchParams,
  HybridSearchResult,
  MemorySourceType,
  MemoryRecord,
} from './types'
import type { EmbeddingProviderManager } from './embedding'

type DatabaseType = InstanceType<typeof Database>

/**
 * 混合搜索器
 */
export class HybridSearcher {
  private db: DatabaseType
  private embeddingProvider: EmbeddingProviderManager
  private vectorEnabled: boolean

  constructor(
    db: DatabaseType,
    embeddingProvider: EmbeddingProviderManager,
    vectorEnabled: boolean,
  ) {
    this.db = db
    this.embeddingProvider = embeddingProvider
    this.vectorEnabled = vectorEnabled
  }

  /**
   * 执行混合搜索
   */
  async search(params: HybridSearchParams): Promise<HybridSearchResult[]> {
    const {
      query,
      maxResults = 10,
      minScore = 0.35,
      vectorWeight = 0.7,
      textWeight = 0.3,
      sourceTypes,
      startTime,
      endTime,
      mmrEnabled = true,
      mmrLambda = 0.7,
      temporalDecayEnabled = true,
      temporalHalfLifeDays = 30,
    } = params

    // 1. 向量搜索（如果启用）
    const vectorResults = this.vectorEnabled
      ? await this.searchVector(query, maxResults * 4, sourceTypes, startTime, endTime)
      : []

    // 2. 全文搜索
    const textResults = await this.searchKeyword(
      query,
      maxResults * 4,
      sourceTypes,
      startTime,
      endTime,
    )

    // 3. 合并结果
    let merged = this.mergeResults(vectorResults, textResults, vectorWeight, textWeight)

    // 4. 应用时间衰减
    if (temporalDecayEnabled) {
      merged = this.applyTemporalDecay(merged, temporalHalfLifeDays)
    }

    // 5. 应用 MMR 重排序
    if (mmrEnabled && merged.length > 1) {
      merged = await this.applyMMR(merged, maxResults, mmrLambda)
    } else {
      merged = merged.slice(0, maxResults)
    }

    // 6. 过滤低分结果
    return merged.filter((r) => r.score >= minScore)
  }

  /**
   * 向量搜索（KNN）
   * 使用 sqlite-vec 的 MATCH 语法
   */
  private async searchVector(
    query: string,
    limit: number,
    sourceTypes?: MemorySourceType[],
    startTime?: number,
    endTime?: number,
  ): Promise<Array<{ id: string; score: number }>> {
    if (!this.vectorEnabled) return []

    // 生成查询向量
    const queryVec = await this.embeddingProvider.embed(query)
    const vecBlob = Buffer.from(new Float32Array(queryVec).buffer)

    // sqlite-vec 使用 MATCH ? AND k = ? 语法
    // 先获取候选结果（使用 KNN 索引）
    const candidateLimit = limit * 4 // 超采样

    const stmt = this.db.prepare(`
      SELECT c.id, vec_distance_cosine(v.embedding, ?) as dist
      FROM memory_vectors v
      JOIN memories c ON c.id = v.memory_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY dist ASC
      LIMIT ?
    `)

    const rows = stmt.all(vecBlob, vecBlob, candidateLimit, limit) as Array<{
      id: string
      dist: number
      source_type: string
      created_at: number
    }>

    // 应用过滤条件
    let filtered = rows
    if (sourceTypes?.length) {
      filtered = filtered.filter((r) => sourceTypes.includes(r.source_type as MemorySourceType))
    }
    if (startTime) {
      filtered = filtered.filter((r) => r.created_at >= startTime)
    }
    if (endTime) {
      filtered = filtered.filter((r) => r.created_at <= endTime)
    }

    return filtered.slice(0, limit).map((r) => ({
      id: r.id,
      score: 1 - r.dist, // 距离转相似度
    }))
  }

  /**
   * 全文搜索（BM25）
   */
  private searchKeyword(
    query: string,
    limit: number,
    sourceTypes?: MemorySourceType[],
    startTime?: number,
    endTime?: number,
  ): Array<{ id: string; score: number }> {
    // 构建 FTS5 查询
    const tokens = query.match(/[\p{L}\p{N}_]+/gu) || []
    if (tokens.length === 0) return []

    const matchQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ')

    // 构建过滤条件
    const filters: string[] = []
    const params: any[] = [matchQuery, limit]

    if (sourceTypes?.length) {
      filters.push(`c.source_type IN (${sourceTypes.map(() => '?').join(',')})`)
      params.splice(1, 0, ...sourceTypes)
    }
    if (startTime) {
      filters.push('c.created_at >= ?')
      params.push(startTime)
    }
    if (endTime) {
      filters.push('c.created_at <= ?')
      params.push(endTime)
    }

    const whereClause = filters.length ? `AND ${filters.join(' AND ')}` : ''

    const stmt = this.db.prepare(`
      SELECT c.id, bm25(memory_fts) as rank
      FROM memory_fts
      JOIN memories c ON c.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? ${whereClause}
      ORDER BY rank ASC
      LIMIT ?
    `)

    const rows = stmt.all(...params) as Array<{ id: string; rank: number }>

    return rows.map((r) => ({
      id: r.id,
      score: this.bm25RankToScore(r.rank),
    }))
  }

  /**
   * BM25 排名转分数
   */
  private bm25RankToScore(rank: number): number {
    if (!Number.isFinite(rank)) return 0.001
    if (rank < 0) {
      const relevance = -rank
      return relevance / (1 + relevance)
    }
    return 1 / (1 + rank)
  }

  /**
   * 合并向量搜索结果和全文搜索结果
   */
  private mergeResults(
    vectorResults: Array<{ id: string; score: number }>,
    textResults: Array<{ id: string; score: number }>,
    vectorWeight: number,
    textWeight: number,
  ): Array<HybridSearchResult & { vectorScore: number; textScore: number }> {
    const byId = new Map<string, { vectorScore: number; textScore: number }>()

    // 添加向量结果
    for (const r of vectorResults) {
      byId.set(r.id, { vectorScore: r.score, textScore: 0 })
    }

    // 合并全文结果
    for (const r of textResults) {
      const existing = byId.get(r.id)
      if (existing) {
        existing.textScore = r.score
      } else {
        byId.set(r.id, { vectorScore: 0, textScore: r.score })
      }
    }

    // 获取完整记录并计算加权分数
    const results: Array<HybridSearchResult & { vectorScore: number; textScore: number }> = []

    for (const [id, scores] of byId) {
      const record = this.getMemoryRecord(id)
      if (!record) continue

      const score = vectorWeight * scores.vectorScore + textWeight * scores.textScore

      results.push({
        id: record.id,
        content: record.content,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
        sourceFile: record.sourceFile,
        sourcePosition: record.sourcePosition,
        createdAt: record.createdAt,
        score,
        vectorScore: scores.vectorScore,
        textScore: scores.textScore,
        snippet: this.truncateText(record.content, 300),
        metadata: JSON.parse(record.metadata || '{}'),
      })
    }

    return results.sort((a, b) => b.score - a.score)
  }

  /**
   * 获取记忆记录
   */
  private getMemoryRecord(id: string): MemoryRecord | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ? AND is_deleted = 0')
    const row = stmt.get(id) as any

    if (!row) return null

    return {
      id: row.id,
      content: row.content,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceFile: row.source_file,
      sourcePosition: row.source_position,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isDeleted: row.is_deleted,
    }
  }

  /**
   * 应用时间衰减
   */
  private applyTemporalDecay(
    results: Array<HybridSearchResult & { vectorScore: number; textScore: number }>,
    halfLifeDays: number,
  ): Array<HybridSearchResult & { vectorScore: number; textScore: number }> {
    const now = Date.now()
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000

    return results
      .map((r) => {
        const age = now - r.createdAt
        const decayFactor = Math.pow(0.5, age / halfLifeMs)
        return {
          ...r,
          score: r.score * decayFactor,
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  /**
   * 应用 MMR（Maximal Marginal Relevance）重排序
   */
  private async applyMMR(
    results: Array<HybridSearchResult & { vectorScore: number; textScore: number }>,
    maxResults: number,
    lambda: number,
  ): Promise<HybridSearchResult[]> {
    const selected: Array<HybridSearchResult & { vectorScore: number; textScore: number }> = []
    const remaining = [...results]

    while (remaining.length > 0 && selected.length < maxResults) {
      let bestMMRScore = -Infinity
      let bestIndex = 0

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]

        // 相关性部分
        const relevance = candidate.score

        // 多样性部分：与已选结果的最大相似度
        let maxSimToSelected = 0
        for (const sel of selected) {
          const sim = await this.calculateSimilarity(candidate, sel)
          maxSimToSelected = Math.max(maxSimToSelected, sim)
        }

        // MMR = λ * Relevance - (1-λ) * max(Similarity)
        const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected

        if (mmrScore > bestMMRScore) {
          bestMMRScore = mmrScore
          bestIndex = i
        }
      }

      selected.push(remaining[bestIndex])
      remaining.splice(bestIndex, 1)
    }

    return selected
  }

  /**
   * 计算两个结果之间的相似度
   */
  private async calculateSimilarity(a: HybridSearchResult, b: HybridSearchResult): Promise<number> {
    // 如果启用了向量，使用向量相似度
    if (this.vectorEnabled) {
      const vecA = await this.getVector(a.id)
      const vecB = await this.getVector(b.id)

      if (vecA && vecB) {
        return this.cosineSimilarity(vecA, vecB)
      }
    }

    // 回退到文本相似度
    return this.jaccardSimilarity(a.content, b.content)
  }

  /**
   * 获取向量
   */
  private getVector(memoryId: string): number[] | null {
    if (!this.vectorEnabled) return null

    const stmt = this.db.prepare('SELECT embedding FROM memory_vectors WHERE memory_id = ?')
    const row = stmt.get(memoryId) as { embedding: Buffer } | undefined

    if (!row) return null

    const floatArray = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    )
    return Array.from(floatArray)
  }

  /**
   * 余弦相似度
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  /**
   * Jaccard 相似度（文本）
   */
  private jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/))
    const setB = new Set(b.toLowerCase().split(/\s+/))

    const intersection = new Set([...setA].filter((x) => setB.has(x)))
    const union = new Set([...setA, ...setB])

    return intersection.size / union.size
  }

  /**
   * 截断文本
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength) + '...'
  }
}

/**
 * 创建混合搜索器
 */
export function createHybridSearcher(
  db: DatabaseType,
  embeddingProvider: EmbeddingProviderManager,
  vectorEnabled: boolean,
): HybridSearcher {
  return new HybridSearcher(db, embeddingProvider, vectorEnabled)
}
