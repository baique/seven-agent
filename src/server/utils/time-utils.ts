/**
 * 时间处理工具类
 * 提供统一的时间格式化和计算功能
 */

/**
 * 格式化日期为YYYYMMDD格式
 * @param date 日期对象
 * @returns 格式化后的日期字符串，如：20200101
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * 格式化时间为HHMMSS格式
 * @param date 时间对象
 * @returns 格式化后的时间字符串，如：123056
 */
export function formatTime(date: Date): string {
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${hour}${minute}${second}`
}

/**
 * 格式化日期时间组合为YYYYMMDDHHMMSS格式
 * @param date 日期时间对象
 * @returns 格式化后的日期时间字符串，如：20200101123056
 */
export function formatDatetime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`
}

/**
 * 获取当前日期
 * @returns 年月日格式：20200101
 */
export function getCurrentDate(): string {
  const now = new Date()
  return formatDate(now)
}

/**
 * 格式化日期为显示格式
 * @param date 日期对象
 * @returns 格式化后的日期字符串，如：2020年01月01日
 */
export function formatDateDisplay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}年${month}月${day}日`
}

/**
 * 格式化时间差
 * 将毫秒数转换为易读的时间差描述
 * @param diffMs 时间差（毫秒）
 * @returns 格式化后的时间差字符串，如：1天2小时30分钟
 */
export function formatTimeDiff(diffMs: number): string {
  const totalSeconds = Math.floor(diffMs / 1000)
  const days = Math.floor(totalSeconds / (60 * 60 * 24))
  const hours = Math.floor((totalSeconds % (60 * 60 * 24)) / (60 * 60))
  const mins = Math.floor((totalSeconds % (60 * 60)) / 60)
  const secs = totalSeconds % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}小时`)
  if (mins > 0) parts.push(`${mins}分钟`)
  if (secs > 0) parts.push(`${secs}秒`)
  return parts.join('') || '0秒'
}

/**
 * 获取时间差描述
 * 根据时间戳返回相对时间描述
 * @param timestamp 时间戳
 * @returns 时间差描述，如：刚刚、5分钟、2小时、3天
 */
export function getTimeSince(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  return `${Math.floor(hours / 24)}天`
}

/**
 * 计算两个时间戳之间的秒数差
 * @param timestamp1 第一个时间戳
 * @param timestamp2 第二个时间戳
 * @returns 秒数差
 */
export function getSecondsDiff(timestamp1: number, timestamp2: number): number {
  const timeDiff = Math.abs(timestamp1 - timestamp2)
  return timeDiff / 1000
}
