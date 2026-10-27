/** Plain-text card summary; never inject a user's HTML into a card. */
export function postExcerpt(source: string): string {
  return source
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}
