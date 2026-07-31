export type HoksiArticleRef = {
  name: string
  rel: string
  folder: string
}

export type HoksiDownloadProgress = {
  i: number
  n: number
  slug: string
  name: string
}

export type HoksiDownloadResult = {
  ok: boolean
  slug: string
  lang?: string
  name: string
  dir: string
  count: number
  articles: HoksiArticleRef[]
}

export type HoksiLang = 'zh-HK' | 'en'

type SseEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; i: number; n: number; slug: string; name: string }
  | ({ type: 'done' } & HoksiDownloadResult)
  | { type: 'error'; ok: false; error: string }

async function readSse(
  res: Response,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  if (!res.body) throw new Error('No response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const flush = (chunk: string) => {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        onEvent(JSON.parse(line.slice(6)) as SseEvent)
      } catch {
        // ignore malformed event
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() || ''
    for (const part of parts) flush(part)
  }
  // Final event may arrive without a trailing blank line before close
  buf += decoder.decode()
  if (buf.trim()) flush(buf)
}

/** Download a Hoksi topic via the Vite dev API (SSE progress). */
export async function downloadHoksiTopic(
  urlOrSlug: string,
  onProgress?: (p: HoksiDownloadProgress | { message: string }) => void,
  lang: HoksiLang = 'zh-HK',
): Promise<HoksiDownloadResult> {
  const res = await fetch('/api/hoksi/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urlOrSlug, lang }),
  })
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status})`)
  }

  let result: HoksiDownloadResult | null = null
  let lastError: string | null = null

  await readSse(res, (ev) => {
    if (ev.type === 'status') onProgress?.({ message: ev.message })
    else if (ev.type === 'progress') onProgress?.(ev)
    else if (ev.type === 'done') result = ev
    else if (ev.type === 'error') lastError = ev.error
  })

  if (lastError) throw new Error(lastError)
  if (!result) throw new Error('Download ended without result')
  return result
}

export async function listHoksiArticles(
  slug: string,
  lang: HoksiLang = 'zh-HK',
): Promise<{
  dir: string
  articles: HoksiArticleRef[]
}> {
  const res = await fetch(
    `/api/hoksi/list?slug=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`,
  )
  const data = (await res.json()) as {
    ok: boolean
    dir?: string
    articles?: HoksiArticleRef[]
    error?: string
  }
  if (!data.ok) throw new Error(data.error || 'List failed')
  return { dir: data.dir || '', articles: data.articles || [] }
}

export async function readHoksiArticle(rel: string): Promise<string> {
  const res = await fetch(`/api/hoksi/read?rel=${encodeURIComponent(rel)}`)
  const data = (await res.json()) as {
    ok: boolean
    markdown?: string
    error?: string
  }
  if (!data.ok || data.markdown == null) {
    throw new Error(data.error || 'Read failed')
  }
  return repairMathForRemark(data.markdown)
}

/** TeX `\$` breaks remark-math `$...$` — replace before preview. */
function sanitizeMathDollars(body: string): string {
  return body.replace(/\\\$/g, '\\unicode{x24}')
}

/**
 * Hoksi stores HTML (not MD). Math is usually inline \\( \\) even with
 * \\begin{aligned}; real line breaks are <br>. Only fix currency \\$ and
 * convert MathJax delimiters — do not force aligned → display.
 */
export function repairMathForRemark(md: string): string {
  let out = md

  out = out.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_m, body: string) => `\n\n$$\n${sanitizeMathDollars(body.trim())}\n$$\n\n`,
  )
  out = out.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_m, body: string) => `$${sanitizeMathDollars(body.trim())}$`,
  )

  const blocks: string[] = []
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => {
    const i = blocks.length
    const b = String(body)
    blocks.push(
      `\n\n$$\n${b.includes('\\$') ? sanitizeMathDollars(b.trim()) : b.trim()}\n$$\n\n`,
    )
    return `@@MATHBLOCK${i}@@`
  })

  // Only rewrite inline $...$ that contain currency \$
  out = out.replace(/\$((?:\\\$|[^$])+?)\$/g, (match, body: string) => {
    if (!body.includes('\\$')) return match
    return `$${sanitizeMathDollars(body.trim())}$`
  })

  out = out.replace(
    /@@MATHBLOCK(\d+)@@/g,
    (_m, n: string) => blocks[Number(n)] ?? '',
  )
  return out.replace(/\n{3,}/g, '\n\n')
}

export function parseHoksiSlug(input: string): string {
  const trimmed = input.trim()
  const m = trimmed.match(/\/topics\/([a-zA-Z0-9._-]+)/)
  if (m) return m[1]
  return (
    trimmed
      .replace(/^https?:\/\/[^/]+\/?/, '')
      .replace(/^\/?(en|zh-HK|zh-TW|zh)\//i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-') || 'topic'
  )
}

/** Detect language from a Hoksi URL (`/en/` or `/zh-HK/`). */
export function parseHoksiLang(input: string, fallback: HoksiLang = 'zh-HK'): HoksiLang {
  const m = input.match(/hoksiresources\.com\/(en|zh-HK|zh-TW|zh)(?:\/|$)/i)
  if (!m) return fallback
  const raw = m[1].toLowerCase()
  if (raw === 'en') return 'en'
  return 'zh-HK'
}
