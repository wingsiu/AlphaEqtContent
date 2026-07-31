import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

const HOKSI_API = 'https://hoksiresources.com/api'
const DOWNLOAD_ROOT = path.resolve(process.cwd(), 'downloads', 'hoksi')

type Folder = {
  slug: string
  name: string
  articles?: ArticleMeta[]
  folders?: Folder[]
}

type ArticleMeta = {
  slug: string
  name: string
}

type Topic = {
  slug: string
  name: string
  folders?: Folder[]
}

type Article = {
  slug: string
  name: string
  sections?: { content?: string; sort_order?: number }[]
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function safeSlug(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'topic'
  )
}

function parseTopicSlug(input: string): string {
  const trimmed = input.trim()
  const m = trimmed.match(/\/topics\/([a-zA-Z0-9._-]+)/)
  if (m) return m[1]
  return safeSlug(trimmed.replace(/^https?:\/\/[^/]+\/?/, '').replace(/^\/?(en|zh-HK|zh-TW|zh)\//i, ''))
}

function parseLang(input: string, fallback = 'zh-HK'): string {
  const m = input.match(/hoksiresources\.com\/(en|zh-HK|zh-TW|zh)(?:\/|$)/i)
  if (m) {
    const raw = m[1].toLowerCase()
    if (raw === 'en') return 'en'
    if (raw === 'zh') return 'zh-HK'
    return m[1]
  }
  return fallback
}

function langDirName(lang: string): string {
  return safeSlug(lang) || 'zh-HK'
}

function collectArticles(topic: Topic): { folder: Folder; article: ArticleMeta }[] {
  const out: { folder: Folder; article: ArticleMeta }[] = []
  const walk = (folder: Folder) => {
    for (const a of folder.articles || []) out.push({ folder, article: a })
    for (const child of folder.folders || []) walk(child)
  }
  for (const f of topic.folders || []) walk(f)
  return out
}

/** Replace TeX `\$` so remark-math won't treat `$` as a delimiter. */
function sanitizeMathDollars(body: string): string {
  return body.replace(/\\\$/g, '\\unicode{x24}')
}

function wrapInlineMath(body: string): string {
  return `$${sanitizeMathDollars(body.trim())}$`
}

/** Light HTML → Markdown; MathJax \\( \\) → remark-math $ / $$. */
export function hoksiHtmlToMarkdown(content: string): string {
  let t = content
  t = t.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim()
      return `\n${'#'.repeat(Number(level))} ${text}\n\n`
    },
  )
  t = t.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n')
  // Markdown hard line break (two spaces + newline) — CommonMark collapses bare \n
  t = t.replace(/<br\s*\/?>/gi, '  \n')
  t = t.replace(/<\/p>\s*<p>/gi, '\n\n')
  t = t.replace(/<\/?p[^>]*>/gi, '\n')
  t = t.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
  t = t.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
  t = t.replace(
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
    '![]($1)',
  )
  t = t.replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
  t = t.replace(/<\/?(ul|ol|div|span)[^>]*>/gi, '')
  t = t.replace(/<[^>]+>/g, '')
  t = t
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\r\n/g, '\n')
  // Convert MathJax delimiters → remark-math (sanitize \$ currency)
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => wrapInlineMath(body))
  t = t.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_m, body: string) => `\n$$\n${sanitizeMathDollars(body.trim())}\n$$\n`,
  )
  t = t.replace(/\n{3,}/g, '\n\n').trim() + '\n'
  return t
}

function articleToMarkdown(data: Article): string {
  const parts = [`# ${data.name || data.slug}`, '', `<!-- source: ${data.slug} -->`, '']
  const sections = [...(data.sections || [])].sort(
    (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
  )
  for (const sec of sections) {
    parts.push(hoksiHtmlToMarkdown(sec.content || ''))
    parts.push('')
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * Conservative repair for remark-math:
 * - \\( \\) / \\[ \\] → $ / $$
 * - only rewrite $...$ when it contains currency \\$
 * Hoksi line breaks are HTML <br>, not aligned→display.
 */
function normalizeMathDelimiters(md: string): string {
  let out = md
  out = out.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_m, body: string) => `\n\n$$\n${sanitizeMathDollars(body.trim())}\n$$\n\n`,
  )
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) =>
    wrapInlineMath(body),
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

  out = out.replace(/\$((?:\\\$|[^$])+?)\$/g, (match, body: string) => {
    if (!body.includes('\\$')) return match
    return wrapInlineMath(body)
  })

  out = out.replace(/@@MATHBLOCK(\d+)@@/g, (_m, n: string) => blocks[Number(n)] ?? '')
  return out.replace(/\n{3,}/g, '\n\n')
}

async function fetchHoksi<T>(apiPath: string): Promise<T> {
  const res = await fetch(`${HOKSI_API}${apiPath}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AlphaEqtContent/0.1',
    },
  })
  if (!res.ok) throw new Error(`Hoksi HTTP ${res.status} for ${apiPath}`)
  return (await res.json()) as T
}

/**
 * Dev API:
 * - POST /api/hoksi/download  { urlOrSlug }  → SSE progress, saves under downloads/hoksi/
 * - GET  /api/hoksi/read?rel=…              → markdown file contents
 * - GET  /api/hoksi/list?slug=…             → saved article index (if any)
 */
export function hoksiDownloadPlugin(): Plugin {
  return {
    name: 'alphaeqt-hoksi-download',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')

          if (req.method === 'GET' && url.pathname === '/api/hoksi/list') {
            const slug = safeSlug(url.searchParams.get('slug') || '')
            const lang = langDirName(url.searchParams.get('lang') || 'zh-HK')
            // Prefer downloads/hoksi/<slug>/<lang>/; fall back to legacy <slug>/ for zh-HK
            let dir = path.join(DOWNLOAD_ROOT, slug, lang)
            let relBase = path.posix.join(slug, lang)
            if (!fs.existsSync(dir) && (lang === 'zh-HK' || lang === 'zh')) {
              const legacy = path.join(DOWNLOAD_ROOT, slug)
              if (fs.existsSync(legacy)) {
                dir = legacy
                relBase = slug
              }
            }
            if (!fs.existsSync(dir)) {
              sendJson(res, 200, { ok: true, lang, articles: [], dir: '' })
              return
            }
            const articles: { name: string; rel: string; folder: string }[] = []
            const walk = (folderAbs: string, folderRel: string) => {
              for (const name of fs.readdirSync(folderAbs)) {
                // Skip sibling language folders when walking legacy root
                if (
                  !folderRel &&
                  fs.statSync(path.join(folderAbs, name)).isDirectory() &&
                  /^(en|zh-HK|zh-TW|zh)$/i.test(name)
                ) {
                  continue
                }
                const abs = path.join(folderAbs, name)
                const rel = folderRel ? `${folderRel}/${name}` : name
                if (fs.statSync(abs).isDirectory()) {
                  walk(abs, rel)
                  continue
                }
                if (!name.endsWith('.md') || name === 'README.md') continue
                const head = fs.readFileSync(abs, 'utf8').slice(0, 200)
                const title =
                  head.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
                  name.replace(/\.md$/, '')
                articles.push({
                  name: title,
                  rel: path.posix.join(relBase, rel.replace(/\\/g, '/')),
                  folder: folderRel || relBase,
                })
              }
            }
            walk(dir, '')
            articles.sort((a, b) => a.rel.localeCompare(b.rel))
            sendJson(res, 200, {
              ok: true,
              lang,
              dir: `downloads/hoksi/${relBase}`,
              articles,
            })
            return
          }

          if (req.method === 'GET' && url.pathname === '/api/hoksi/read') {
            const rel = url.searchParams.get('rel') || ''
            if (!rel || rel.includes('..')) {
              sendJson(res, 400, { ok: false, error: 'bad path' })
              return
            }
            const abs = path.resolve(DOWNLOAD_ROOT, rel)
            if (!abs.startsWith(DOWNLOAD_ROOT) || !fs.existsSync(abs)) {
              sendJson(res, 404, { ok: false, error: 'not found' })
              return
            }
            const markdown = normalizeMathDelimiters(fs.readFileSync(abs, 'utf8'))
            sendJson(res, 200, { ok: true, rel, markdown })
            return
          }

          if (req.method === 'POST' && url.pathname === '/api/hoksi/download') {
            await handleDownload(req, res)
            return
          }

          next()
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    },
  }
}

async function handleDownload(req: IncomingMessage, res: ServerResponse) {
  const raw = await readBody(req)
  const body = JSON.parse(raw || '{}') as { urlOrSlug?: string; lang?: string }
  const urlOrSlug = body.urlOrSlug || 'hkdse-maths-core-solutions'
  const slug = parseTopicSlug(urlOrSlug)
  const lang = langDirName(body.lang || parseLang(urlOrSlug, 'zh-HK'))

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    // Ensure progress reaches the browser promptly
    const anyRes = res as ServerResponse & { flush?: () => void }
    anyRes.flush?.()
  }

  try {
    send({ type: 'status', message: `Fetching topic “${slug}” (${lang})…` })
    const topic = await fetchHoksi<Topic>(`/topics/${encodeURIComponent(slug)}`)
    const pairs = collectArticles(topic)
    const outDir = path.join(DOWNLOAD_ROOT, slug, lang)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(
      path.join(outDir, '_topic.json'),
      JSON.stringify(topic, null, 2),
      'utf8',
    )

    const saved: { name: string; rel: string; folder: string }[] = []
    const indexRows = [
      `# ${topic.name} (${lang})`,
      '',
      `Source: https://hoksiresources.com/${lang}/topics/${slug}`,
      `Articles: ${pairs.length}`,
      '',
      '| Folder | Article | File |',
      '|--------|---------|------|',
    ]

    for (let i = 0; i < pairs.length; i++) {
      const { folder, article } = pairs[i]
      send({
        type: 'progress',
        i: i + 1,
        n: pairs.length,
        slug: article.slug,
        name: article.name,
      })

      const data = await fetchHoksi<Article>(
        `/articles/${encodeURIComponent(article.slug)}?lang=${encodeURIComponent(lang)}`,
      )
      const folderDir = path.join(outDir, folder.slug)
      fs.mkdirSync(folderDir, { recursive: true })
      fs.writeFileSync(
        path.join(folderDir, `${article.slug}.json`),
        JSON.stringify(data, null, 2),
        'utf8',
      )
      const md = articleToMarkdown(data)
      const mdName = `${article.slug}.md`
      fs.writeFileSync(path.join(folderDir, mdName), md, 'utf8')
      const rel = path.posix.join(slug, lang, folder.slug, mdName)
      saved.push({ name: data.name || article.name, rel, folder: folder.name })
      indexRows.push(
        `| ${folder.name} | ${data.name || article.name} | [${folder.slug}/${mdName}](${folder.slug}/${mdName}) |`,
      )
    }

    fs.writeFileSync(path.join(outDir, 'README.md'), indexRows.join('\n') + '\n', 'utf8')
    send({
      type: 'done',
      ok: true,
      slug,
      lang,
      name: topic.name,
      dir: `downloads/hoksi/${slug}/${lang}`,
      count: saved.length,
      articles: saved.slice(0, 1),
    })
  } catch (err) {
    send({
      type: 'error',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    res.end()
  }
}
