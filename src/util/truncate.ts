export function truncateMessage(text: string, maxLength = 3500): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n... (已截断，共 ${text.length} 字符)`
}
