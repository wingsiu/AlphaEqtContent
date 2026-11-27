/**
 * Client for the FastAPI editorial app (`uvicorn editorial_api:app` on
 * 127.0.0.1:8505). Vite proxies `/api/editorial` at that process.
 *
 * A content page is an ordered list of atoms. Question atoms are sent as
 * kind "question" so the API creates a questions row. Kind "stem" is not
 * sent. Ordinary atoms do not include source_type.
 */

export type PageKind = 'note' | 'web' | 'app'
export type AtomKind =
  | 'question'
  | 'text'
  | 'figure'
  | 'title'
  | 'formula'
  | 'topic'
  | 'theorem'
export type SourceType = 'A' | 'S' | 'P'
export type QKind = 'MC' | 'SQ' | 'LQ'

export type AtomInput = {
  kind: AtomKind
  title?: string
  markdown: string
  qkind?: QKind
  /** Omitted when blank so the API uses the paper default, else author (A). */
  sourceType?: '' | SourceType
  marks?: number | null
  figure?: { title?: string; markdown: string } | null
}

export type PaperInput = {
  slug: string
  title: string
  sourceType?: '' | SourceType
}

export type ContentPageItem = {
  sortorder: number
  content_block_id: number
  revision_id: number
  revision_no: number
  title: string | null
  kind: string
  markdown: string
  question_id: number | null
}

export type ContentPageDocument = {
  page: {
    id: number | null
    slug: string
    title: string
    kind: string
    status: string
    current_version_id: number | null
  }
  version: {
    id: number
    version_no: number | null
    note: string | null
    status: string
  } | null
  items: ContentPageItem[]
  paper_id?: number | null
}

const EDITORIAL_API = '/api/editorial'
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ATOM_KINDS = new Set<AtomKind>([
  'question',
  'text',
  'figure',
  'title',
  'formula',
  'topic',
  'theorem',
])
const PAGE_KINDS = new Set<PageKind>(['note', 'web', 'app'])

export class ContentPageError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ContentPageError'
    this.status = status
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function slugMessage(label: string): string {
  return `${label} must be 1-64 characters of letters, digits, hyphen, or underscore`
}

function assertSlug(value: string, label: string): string {
  const slug = value.trim()
  if (!SLUG_RE.test(slug)) {
    throw new ContentPageError(400, 'bad_slug', slugMessage(label))
  }
  return slug
}

function sourceValue(value: '' | SourceType | undefined): SourceType | undefined {
  if (value === 'A' || value === 'S' || value === 'P') return value
  return undefined
}

export function buildPaper(
  paper: PaperInput | null | undefined,
): Record<string, unknown> | undefined {
  if (!paper) return undefined
  const slug = paper.slug.trim()
  const title = paper.title.trim()
  const sourceType = sourceValue(paper.sourceType)
  if (!slug && !title && !sourceType) return undefined
  const body: Record<string, unknown> = {
    slug: assertSlug(slug, 'paper.slug'),
  }
  if (!title) {
    throw new ContentPageError(400, 'bad_item', 'paper.title is required')
  }
  if (title.length > 255) {
    throw new ContentPageError(
      400,
      'bad_item',
      'paper.title is longer than 255 characters',
    )
  }
  body.title = title
  if (sourceType) body.source_type = sourceType
  return body
}

export function buildAtomBody(
  item: AtomInput,
  label: string,
): Record<string, unknown> {
  if (!ATOM_KINDS.has(item.kind)) {
    throw new ContentPageError(
      400,
      'bad_kind',
      `${label} kind must be question, text, figure, title, formula, topic, or theorem`,
    )
  }
  if (typeof item.markdown !== 'string' || item.markdown.trim() === '') {
    throw new ContentPageError(400, 'bad_item', `${label} needs markdown`)
  }
  if (item.markdown.length > 1_000_000) {
    throw new ContentPageError(
      400,
      'bad_item',
      `${label} markdown is longer than 1000000 characters`,
    )
  }
  const title = item.title?.trim() ?? ''
  if (title.length > 255) {
    throw new ContentPageError(
      400,
      'bad_item',
      `${label} title is longer than 255 characters`,
    )
  }
  const body: Record<string, unknown> = {
    kind: item.kind,
    markdown: item.markdown,
  }
  if (title) body.title = title
  if (item.kind !== 'question') return body

  const qkind = item.qkind ?? 'MC'
  if (qkind !== 'MC' && qkind !== 'SQ' && qkind !== 'LQ') {
    throw new ContentPageError(400, 'bad_qkind', 'qkind must be MC, SQ, or LQ')
  }
  body.qkind = qkind
  const sourceType = sourceValue(item.sourceType)
  if (sourceType) body.source_type = sourceType
  if (item.marks != null) {
    if (
      !Number.isInteger(item.marks) ||
      item.marks < 0 ||
      item.marks > 10000
    ) {
      throw new ContentPageError(
        400,
        'bad_item',
        'marks must be a whole number from 0 to 10000',
      )
    }
    body.marks = item.marks
  }
  const figureMarkdown = item.figure?.markdown
  if (figureMarkdown && figureMarkdown.trim() !== '') {
    if (figureMarkdown.length > 1_000_000) {
      throw new ContentPageError(
        400,
        'bad_item',
        'figure markdown is longer than 1000000 characters',
      )
    }
    const figure: Record<string, unknown> = { markdown: figureMarkdown }
    const figureTitle = item.figure?.title?.trim() ?? ''
    if (figureTitle.length > 255) {
      throw new ContentPageError(
        400,
        'bad_item',
        'figure title is longer than 255 characters',
      )
    }
    if (figureTitle) figure.title = figureTitle
    body.figure = figure
  }
  return body
}

export function buildImportBody(input: {
  slug: string
  title: string
  kind: PageKind
  paper?: PaperInput | null
  items: AtomInput[]
}): Record<string, unknown> {
  if (!PAGE_KINDS.has(input.kind)) {
    throw new ContentPageError(400, 'bad_kind', 'page.kind must be note, web, or app')
  }
  const title = input.title.trim()
  if (!title) {
    throw new ContentPageError(400, 'bad_item', 'page.title is required')
  }
  if (title.length > 255) {
    throw new ContentPageError(
      400,
      'bad_item',
      'page.title is longer than 255 characters',
    )
  }
  if (input.items.length === 0) {
    throw new ContentPageError(
      400,
      'bad_item',
      'Add at least one atom before creating the page.',
    )
  }
  const body: Record<string, unknown> = {
    page: {
      slug: assertSlug(input.slug, 'page.slug'),
      title,
      kind: input.kind,
      status: 'D',
    },
    items: input.items.map((item, index) =>
      buildAtomBody(item, `Atom ${index + 1}`),
    ),
  }
  const paper = buildPaper(input.paper)
  if (paper) body.paper = paper
  return body
}

export function buildAppendBody(
  item: AtomInput,
  paper?: PaperInput | null,
): Record<string, unknown> {
  const body = buildAtomBody(item, 'This atom')
  if (item.kind === 'question') {
    const paperBody = buildPaper(paper)
    if (paperBody) body.paper = paperBody
  }
  return body
}

export function buildEditBody(
  markdown: string,
  title: string,
): { markdown: string; title: string | null } {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new ContentPageError(400, 'bad_item', 'markdown is required')
  }
  if (markdown.length > 1_000_000) {
    throw new ContentPageError(
      400,
      'bad_item',
      'markdown is longer than 1000000 characters',
    )
  }
  const trimmed = title.trim()
  if (trimmed.length > 255) {
    throw new ContentPageError(
      400,
      'bad_item',
      'title is longer than 255 characters',
    )
  }
  return { markdown, title: trimmed ? trimmed : null }
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ContentPageDocument> {
  let res: Response
  try {
    res = await fetch(`${EDITORIAL_API}${path}`, {
      method,
      headers:
        body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ContentPageError(
      0,
      'unreachable',
      'Editorial API is not reachable at 127.0.0.1:8505. Is uvicorn editorial_api:app running?',
    )
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const record =
      data && typeof data === 'object'
        ? (data as { error?: unknown; message?: unknown })
        : {}
    const code = typeof record.error === 'string' ? record.error : 'request_failed'
    let message =
      typeof record.message === 'string'
        ? record.message
        : `Editorial API HTTP ${res.status}`
    if (
      typeof record.message !== 'string' &&
      (res.status === 500 || res.status === 502 || res.status === 504)
    ) {
      message = `Editorial API is not reachable at 127.0.0.1:8505 (HTTP ${res.status}). Is uvicorn editorial_api:app running?`
    }
    throw new ContentPageError(res.status, code, message)
  }
  if (!data || typeof data !== 'object' || !('page' in data)) {
    throw new ContentPageError(
      500,
      'bad_response',
      'Editorial API returned an unexpected payload',
    )
  }
  return data as ContentPageDocument
}

function pagePath(slug: string, suffix = ''): string {
  return `/content/pages/${encodeURIComponent(assertSlug(slug, 'page.slug'))}${suffix}`
}

export function createContentPage(input: {
  slug: string
  title: string
  kind: PageKind
  paper?: PaperInput | null
  items: AtomInput[]
}): Promise<ContentPageDocument> {
  return request('POST', '/content/pages', buildImportBody(input))
}

export function getContentPage(slug: string): Promise<ContentPageDocument> {
  return request('GET', pagePath(slug))
}

export function appendContentItem(
  slug: string,
  item: AtomInput,
  paper?: PaperInput | null,
): Promise<ContentPageDocument> {
  return request('POST', pagePath(slug, '/items'), buildAppendBody(item, paper))
}

export function editContentItem(
  slug: string,
  sortorder: number,
  markdown: string,
  title: string,
): Promise<ContentPageDocument> {
  if (!Number.isInteger(sortorder) || sortorder < 1) {
    throw new ContentPageError(400, 'bad_item', 'sortorder must be a positive integer')
  }
  return request(
    'POST',
    pagePath(slug, `/items/${sortorder}`),
    buildEditBody(markdown, title),
  )
}

export function publishContentPage(slug: string): Promise<ContentPageDocument> {
  return request('POST', pagePath(slug, '/publish'))
}

/** Next draft version. An empty body clones the current pins. */
export function openDraftVersion(slug: string): Promise<ContentPageDocument> {
  return request('POST', pagePath(slug, '/versions'), {})
}
