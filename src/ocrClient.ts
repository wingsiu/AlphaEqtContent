/** Formula crop OCR + smart PDF/page pipeline clients. */

import { toMarkdownMath } from './mathFormat'

export type OcrEngine = 'unimernet' | 'pix2tex' | 'page'

export type OcrResult = {
  latex: string
  markdown: string
  engine: OcrEngine
}

export type PageOcrResult = {
  markdown: string
  slug: string
  figures: string[]
  dir: string
  pages: number
  /** Per-page analysis from OCR (blocks for crop rebuild). */
  analysis?: Record<string, unknown> | Record<string, unknown>[]
}

export type PageOcrProgress = {
  page: number
  total: number
  phase: 'render' | 'ocr' | 'done'
}

const ENGINE_PATH: Record<'unimernet' | 'pix2tex', string> = {
  unimernet: '/api/ocr/predict/',
  pix2tex: '/api/ocr-pix2tex/predict/',
}

function cleanLatex(raw: string): string {
  let s = raw.trim()
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1)
  }
  s = s.replace(/\\"/g, '"').trim()
  if (s.startsWith('$$') && s.endsWith('$$')) s = s.slice(2, -2).trim()
  else if (s.startsWith('\\(') && s.endsWith('\\)')) s = s.slice(2, -2).trim()
  else if (s.startsWith('$') && s.endsWith('$')) s = s.slice(1, -1).trim()
  return s
}

export async function ocrImageToMarkdown(
  file: File,
  engine: OcrEngine = 'unimernet',
): Promise<OcrResult> {
  if (engine === 'page') {
    const page = await ocrPageToMarkdown(file)
    return { latex: '', markdown: page.markdown, engine: 'page' }
  }

  const form = new FormData()
  form.append('file', file)

  const res = await fetch(ENGINE_PATH[engine], {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    const hint =
      engine === 'unimernet'
        ? 'Is UniMERNet running?  python3 AlphaEqtIngest/Tools/unimernet_api.py'
        : 'Is pix2tex Docker running on :8502?'
    throw new Error(errText || `OCR failed (HTTP ${res.status}). ${hint}`)
  }

  const contentType = res.headers.get('content-type') || ''
  let latex: string
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as unknown
    if (data && typeof data === 'object' && 'error' in (data as object)) {
      throw new Error(String((data as { error: string }).error))
    }
    latex = typeof data === 'string' ? data : JSON.stringify(data)
  } else {
    latex = await res.text()
  }

  latex = cleanLatex(latex)
  if (!latex) throw new Error('OCR returned empty LaTeX')

  return { latex, markdown: toMarkdownMath(latex), engine }
}

/** Full PDF/page pipeline with live progress (NDJSON stream). */
export async function ocrPageToMarkdown(
  file: File,
  opts: {
    page?: number
    maxPages?: number
    /** e.g. "all", "6", "6-8", "1,3,5-7" */
    pages?: string
    slug?: string
    onProgress?: (p: PageOcrProgress) => void
  } = {},
): Promise<PageOcrResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('page', String(opts.page ?? 0))
  form.append('max_pages', String(opts.maxPages ?? 40))
  if (opts.pages) form.append('pages', opts.pages)
  if (opts.slug) form.append('slug', opts.slug)

  const res = await fetch('/api/page-ocr/page/stream/', {
    method: 'POST',
    body: form,
  })
  if (!res.ok || !res.body) {
    let err = `Page OCR failed (HTTP ${res.status}). Is smart_page_api on :8504?`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) err = data.error
    } catch {
      /* ignore */
    }
    throw new Error(err)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: PageOcrResult | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let ev: {
        type?: string
        page?: number
        total?: number
        pages?: number
        phase?: string
        ok?: boolean
        markdown?: string
        slug?: string
        figures?: string[]
        dir?: string
        error?: string
        analysis?: Record<string, unknown> | Record<string, unknown>[]
      }
      try {
        ev = JSON.parse(trimmed) as typeof ev
      } catch {
        continue
      }
      if (ev.type === 'start' && typeof ev.pages === 'number') {
        opts.onProgress?.({ page: 0, total: ev.pages, phase: 'ocr' })
      } else if (
        (ev.type === 'progress' || ev.type === 'page_done') &&
        typeof ev.page === 'number' &&
        typeof ev.total === 'number'
      ) {
        const phase =
          ev.type === 'page_done'
            ? 'done'
            : ev.phase === 'render'
              ? 'render'
              : 'ocr'
        opts.onProgress?.({ page: ev.page, total: ev.total, phase })
      } else if (ev.type === 'error') {
        throw new Error(ev.error || 'Page OCR failed')
      } else if (ev.type === 'done' && ev.ok && ev.markdown) {
        result = {
          markdown: ev.markdown,
          slug: ev.slug || '',
          figures: ev.figures || [],
          dir: ev.dir || '',
          pages: ev.pages || 1,
          analysis: ev.analysis,
        }
      }
    }
  }

  if (!result) {
    throw new Error('Page OCR stream ended without a result')
  }
  return result
}

/** Page count for PDF picker (mirrors sample page select). */
export async function fetchPdfMeta(
  file: File,
): Promise<{ pages: number; filename: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/page-ocr/pdf/meta/', {
    method: 'POST',
    body: form,
  })
  const data = (await res.json()) as {
    ok?: boolean
    pages?: number
    filename?: string
    error?: string
  }
  if (!res.ok || !data.ok || !data.pages) {
    throw new Error(data.error || `PDF meta failed (HTTP ${res.status})`)
  }
  return {
    pages: data.pages,
    filename: data.filename || file.name,
  }
}

async function readJsonResponse<T extends { ok?: boolean; error?: string }>(
  res: Response,
  label: string,
): Promise<T> {
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('application/json')) {
    throw new Error(
      `${label}: got ${ct || 'non-JSON'} (HTTP ${res.status}). Is smart_page_api on :8504?`,
    )
  }
  const data = (await res.json()) as T
  return data
}

/** Load OCR analysis (blocks + formula boxes) for crop rebuild. */
export async function fetchPageAnalysis(
  slug: string,
  page: number,
): Promise<{
  blocks: unknown[]
  width?: number
  height?: number
  formulas?: { kind?: string; box?: number[]; text?: string }[]
  layout?: { kind?: string; box?: number[]; score?: number }[]
  layout_corrected?: { kind?: string; box?: number[]; score?: number }[]
}> {
  const res = await fetch(
    `/api/page-ocr/analysis/${encodeURIComponent(slug)}/${page}`,
  )
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    blocks?: unknown[]
    width?: number
    height?: number
    formulas?: { kind?: string; box?: number[]; text?: string }[]
    layout?: { kind?: string; box?: number[]; score?: number }[]
    layout_corrected?: { kind?: string; box?: number[]; score?: number }[]
  }>(res, 'Analysis')
  if (!res.ok || !data.ok) {
    throw new Error(
      data.error || `No analysis for p.${page} — OCR that page once first`,
    )
  }
  return {
    blocks: data.blocks || [],
    width: data.width,
    height: data.height,
    formulas: data.formulas || [],
    layout: data.layout || [],
    layout_corrected: data.layout_corrected || [],
  }
}

export type LayoutRegionPayload = {
  kind: string
  box: [number, number, number, number]
  score?: number
}

/** Save user-corrected YOLO layout (+ export training label). */
export async function saveLayoutCorrection(payload: {
  slug: string
  page: number
  width: number
  height: number
  regions: LayoutRegionPayload[]
  source_url?: string
}): Promise<{
  train_pairs?: number
  regions?: number
  auto_retrain?: {
    queued?: boolean
    reason?: string
    train_pairs?: number
    epochs?: number
    already_running?: boolean
  }
}> {
  const res = await fetch('/api/page-ocr/layout/save/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    train_pairs?: number
    regions?: number
    auto_retrain?: {
      queued?: boolean
      reason?: string
      train_pairs?: number
      epochs?: number
      already_running?: boolean
    }
  }>(res, 'Save layout')
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Save layout failed (HTTP ${res.status})`)
  }
  return data
}

/** Re-run full OCR pipeline using saved or inline corrected layout (+ optional MFD). */
export async function rerunPageWithLayout(payload: {
  slug: string
  page: number
  source_url?: string
  regions?: LayoutRegionPayload[]
  mfd?: { box: [number, number, number, number]; type?: string; score?: number }[]
}): Promise<{ markdown: string; combined_markdown?: string }> {
  const res = await fetch('/api/page-ocr/layout/rerun/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    markdown?: string
    combined_markdown?: string
  }>(res, 'Layout rerun')
  if (!res.ok || !data.ok || !data.markdown) {
    throw new Error(data.error || `Layout rerun failed (HTTP ${res.status})`)
  }
  return {
    markdown: data.markdown,
    combined_markdown: data.combined_markdown,
  }
}

/** Fine-tune DocLayout-YOLO on saved corrections (background by default). */
export async function trainLayoutModel(opts: {
  epochs?: number
  async?: boolean
} = {}): Promise<{
  best_weights?: string
  images?: number
  hint?: string
  queued?: boolean
  reason?: string
}> {
  const res = await fetch('/api/page-ocr/layout/train/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      epochs: opts.epochs ?? 20,
      async: opts.async !== false,
    }),
  })
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    best_weights?: string
    images?: number
    hint?: string
    queued?: boolean
    reason?: string
  }>(res, 'Train layout')
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Train layout failed (HTTP ${res.status})`)
  }
  return data
}

/** Training dataset stats. */
export async function fetchLayoutStatus(): Promise<{
  images?: number
  train_list?: number
  weights?: string | null
  auto_retrain?: boolean
  train_running?: boolean
  train_pending?: boolean
  train_last_ok?: boolean | null
  train_last_error?: string | null
  mfd?: {
    images?: number
    train_list?: number
    weights?: string | null
    train_running?: boolean
    train_last_ok?: boolean | null
    train_last_error?: string | null
  }
  mfd_train_running?: boolean
  mfd_train_list?: number
}> {
  const res = await fetch('/api/page-ocr/layout/status/')
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    images?: number
    train_list?: number
    weights?: string | null
    auto_retrain?: boolean
    train_running?: boolean
    train_pending?: boolean
    train_last_ok?: boolean | null
    train_last_error?: string | null
    mfd?: {
      images?: number
      train_list?: number
      weights?: string | null
      train_running?: boolean
      train_last_ok?: boolean | null
      train_last_error?: string | null
    }
    mfd_train_running?: boolean
    mfd_train_list?: number
  }>(res, 'Layout status')
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Layout status failed (HTTP ${res.status})`)
  }
  return data
}

export type DetectPageResult = {
  slug: string
  page: number
  source_url: string
  width: number
  height: number
  layout: LayoutRegionPayload[]
  mfd: { box: [number, number, number, number]; type?: string; score?: number }[]
  layout_used?: string
}

/** Detect layout + MFD only (training pause before finish OCR). */
export async function detectPageLayoutMfd(
  file: File,
  opts: { page?: number; slug?: string } = {},
): Promise<DetectPageResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('page', String(opts.page ?? 1))
  if (opts.slug) form.append('slug', opts.slug)
  const res = await fetch('/api/page-ocr/page/detect/', {
    method: 'POST',
    body: form,
  })
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    slug?: string
    page?: number
    source_url?: string
    width?: number
    height?: number
    layout?: LayoutRegionPayload[]
    mfd?: { box: number[]; type?: string; score?: number }[]
    layout_used?: string
  }>(res, 'Detect')
  if (!res.ok || !data.ok || !data.slug || !data.source_url) {
    throw new Error(data.error || `Detect failed (HTTP ${res.status})`)
  }
  const mfd = (data.mfd || []).map((m) => ({
    box: [m.box[0]!, m.box[1]!, m.box[2]!, m.box[3]!] as [
      number,
      number,
      number,
      number,
    ],
    type: m.type,
    score: m.score,
  }))
  return {
    slug: data.slug,
    page: data.page || opts.page || 1,
    source_url: data.source_url,
    width: data.width || 0,
    height: data.height || 0,
    layout: data.layout || [],
    mfd,
    layout_used: data.layout_used,
  }
}

/** Confirm edited layout+MFD → save/retrain → finish OCR. */
export async function continuePageOcr(payload: {
  slug: string
  page: number
  source_url?: string
  width?: number
  height?: number
  layout: LayoutRegionPayload[]
  mfd: { box: [number, number, number, number]; type?: string; score?: number }[]
}): Promise<{
  markdown: string
  combined_markdown?: string
  auto_retrain_layout?: { queued?: boolean; reason?: string }
  auto_retrain_mfd?: { queued?: boolean; reason?: string }
}> {
  const res = await fetch('/api/page-ocr/page/continue/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await readJsonResponse<{
    ok?: boolean
    error?: string
    markdown?: string
    combined_markdown?: string
    auto_retrain_layout?: { queued?: boolean; reason?: string }
    auto_retrain_mfd?: { queued?: boolean; reason?: string }
  }>(res, 'Continue OCR')
  if (!res.ok || !data.ok || !data.markdown) {
    throw new Error(data.error || `Continue OCR failed (HTTP ${res.status})`)
  }
  return {
    markdown: data.markdown,
    combined_markdown: data.combined_markdown,
    auto_retrain_layout: data.auto_retrain_layout,
    auto_retrain_mfd: data.auto_retrain_mfd,
  }
}

/** Replace or insert a `## Page N` section in combined markdown (numeric order).
 * Removes every existing section for that page (handles accidental duplicates).
 */
export function upsertPageMarkdown(
  prev: string,
  pageNo: number,
  pageChunk: string,
): string {
  const chunk = pageChunk.trim() + '\n'
  const heads = [...prev.matchAll(/^## Page (\d+)\b.*$/gm)]
  if (!heads.length) {
    return chunk.replace(/\n{3,}/g, '\n\n')
  }

  const preamble = prev.slice(0, heads[0]!.index!).trimEnd()
  const byPage = new Map<number, string>()
  for (let i = 0; i < heads.length; i++) {
    const m = heads[i]!
    const pn = Number(m[1])
    const start = m.index!
    const end =
      i + 1 < heads.length ? heads[i + 1]!.index! : prev.length
    // Keep last occurrence of each page; drop pageNo (replaced below)
    if (pn === pageNo) continue
    byPage.set(pn, prev.slice(start, end).trim())
  }
  byPage.set(pageNo, chunk.trim())

  const body = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('\n\n')

  return (
    (preamble ? preamble + '\n\n' : '') +
    body +
    '\n'
  ).replace(/\n{3,}/g, '\n\n')
}

export type SampleManifest = {
  id: string
  title: string
  pages: { page: number; file: string; w?: number; h?: number }[]
  /** Precomputed OCR draft under /samples/<id>/… */
  ocr_md?: string
  /** Optional source PDF under /samples/<id>/… (default upload). */
  source_pdf?: string
}

export async function loadSampleManifest(
  sampleId: string,
): Promise<SampleManifest> {
  const res = await fetch(`/samples/${sampleId}/manifest.json`)
  if (!res.ok) throw new Error(`Sample manifest missing (${sampleId})`)
  return (await res.json()) as SampleManifest
}

export async function fetchSampleOcrDraft(sampleId: string, path: string): Promise<string> {
  const res = await fetch(`/samples/${sampleId}/${path}`)
  if (!res.ok) throw new Error(`Sample OCR draft missing: ${path}`)
  return res.text()
}

export async function fetchSamplePageFile(
  sampleId: string,
  file: string,
  pageNo: number,
): Promise<File> {
  const res = await fetch(`/samples/${sampleId}/${file}`)
  if (!res.ok) throw new Error(`Sample page missing: ${file}`)
  const blob = await res.blob()
  return new File([blob], `p${String(pageNo).padStart(2, '0')}.png`, {
    type: blob.type || 'image/png',
  })
}

/** Fetch the sample source PDF as a File (for default upload staging). */
export async function fetchSamplePdfFile(
  sampleId: string,
  pdfPath: string,
): Promise<File> {
  const res = await fetch(`/samples/${sampleId}/${pdfPath}`)
  if (!res.ok) throw new Error(`Sample PDF missing: ${pdfPath}`)
  const blob = await res.blob()
  const name = pdfPath.split('/').pop() || `${sampleId}.pdf`
  return new File([blob], name, { type: blob.type || 'application/pdf' })
}
