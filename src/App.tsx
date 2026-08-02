import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeMathjax from 'rehype-mathjax'
import { wordFileToMarkdown } from './wordToMarkdown'
import {
  downloadHoksiTopic,
  listHoksiArticles,
  parseHoksiLang,
  parseHoksiSlug,
  readHoksiArticle,
  type HoksiArticleRef,
  type HoksiLang,
} from './hoksiClient'
import {
  ocrImageToMarkdown,
  ocrPageToMarkdown,
  fetchPdfMeta,
  upsertPageMarkdown,
  loadSampleManifest,
  fetchSamplePageFile,
  fetchSamplePdfFile,
  fetchSampleOcrDraft,
  fetchPageAnalysis,
  saveLayoutCorrection,
  rerunPageWithLayout,
  trainLayoutModel,
  fetchLayoutStatus,
  detectPageLayoutMfd,
  continuePageOcr,
  type OcrEngine,
  type SampleManifest,
} from './ocrClient'
import { normalizeMathDelimiters, prepareMarkdownForPreview, stripFormulaPartMarkers } from './mathFormat'
import { EditorPartZoom, parseDocParts } from './EditorPartZoom'
import {
  PageCropEditor,
  type LayoutRegionEdit,
  type MfdRegionEdit,
} from './PageCropEditor'
import SAMPLE from './samples/dse2015_math_cp2_ocr.md?raw'
import './App.css'

const DEFAULT_HOKSI =
  'https://hoksiresources.com/zh-HK/topics/hkdse-maths-core-solutions'

const SAMPLE_PAPER_ID = 'dse2015-math-cp2'

/** Pull a leading label (e.g. 31. or A.) into a fixed-width tab-stop column. */
function splitLeadingLabel(
  children: ReactNode,
  pattern: RegExp,
): { label: string; body: ReactNode } | null {
  const nodes = Children.toArray(children)
  if (nodes.length === 0) return null

  const first = nodes[0]

  // e.g. loose list <li><p>A. …</p></li> (p may be a custom component)
  if (isValidElement<{ children?: ReactNode }>(first)) {
    const inner = splitLeadingLabel(first.props.children, pattern)
    if (inner) {
      return {
        label: inner.label,
        body: [
          cloneElement(first as ReactElement<{ children?: ReactNode }>, {
            children: inner.body,
          }),
          ...nodes.slice(1),
        ],
      }
    }
  }

  if (typeof first !== 'string') return null
  const match = first.match(pattern)
  if (!match) return null

  const remainder = match[3] ?? ''
  const body = remainder ? [remainder, ...nodes.slice(1)] : nodes.slice(1)
  const label = match[1].endsWith('.') ? match[1] : `${match[1]}.`
  return { label, body }
}

const OPTION_LABEL = /^([A-D]\.)(\s*)([\s\S]*)$/
/** Match N. or N\. (preview prep escapes the dot so remark does not emit <ol>). */
const QUESTION_NUMBER = /^(\d+)(?:\.|\\\.)(\s*)([\s\S]*)$/
/** Include the trailing '.' in the label (same as A./B.) — group1 was bare "I" before. */
const ROMAN_LABEL = /^((?:I{1,3}|IV)\.)(\s*)([\s\S]*)$/

function extractListItemText(children: ReactNode): string {
  const nodes = Children.toArray(children)
  const bits: string[] = []
  for (const n of nodes) {
    if (typeof n === 'string' || typeof n === 'number') {
      bits.push(String(n))
      continue
    }
    if (isValidElement<{ children?: ReactNode }>(n)) {
      bits.push(extractListItemText(n.props.children))
    }
  }
  return bits.join('')
}

function McqListItem({
  children,
  ...props
}: React.ComponentPropsWithoutRef<'li'>) {
  const opt = splitLeadingLabel(children, OPTION_LABEL)
  if (opt) {
    return (
      <li {...props} className="mcq-option">
        <span className="mcq-label">{opt.label}</span>
        <span className="mcq-body">{opt.body}</span>
      </li>
    )
  }
  const roman = splitLeadingLabel(children, ROMAN_LABEL)
  if (roman) {
    return (
      <li {...props} className="roman-option">
        <span className="roman-label">{roman.label}</span>
        <span className="roman-body">{roman.body}</span>
      </li>
    )
  }
  return <li {...props}>{children}</li>
}

/** After options, clear any floated figure so the next question is full-width below. */
function PreviewUl({
  children,
  ...props
}: React.ComponentPropsWithoutRef<'ul'>) {
  const kids = Children.toArray(children)
  const texts = kids.map((k) =>
    isValidElement<{ children?: ReactNode }>(k)
      ? extractListItemText(k.props.children).trim()
      : '',
  )
  const labeled = texts.filter((t) => t.length > 0)
  const romanCount = labeled.filter((t) => /^(I{1,3}|IV)\./.test(t)).length
  const optCount = labeled.filter((t) => /^[A-D]\./.test(t)).length
  // Prefer roman-list only when this ul is mostly I–III (not a merged A–D dump)
  const isRomanList = romanCount >= 2 && romanCount >= optCount
  return (
    <>
      <ul
        {...props}
        className={[props.className, isRomanList ? 'roman-list' : 'mcq-list']
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </ul>
      {/* Clear float only after A–D — after roman it drops options below the
          figure and opens a tall gap (p12 Q36). */}
      {!isRomanList ? (
        <div className="figure-clear" aria-hidden="true" />
      ) : null}
    </>
  )
}

function resolveRelativeFigureSrc(
  src: string | undefined,
  markdown: string,
): string {
  if (!src) return ''
  if (src.startsWith('/') || src.startsWith('http')) return src
  if (!/^figure[\w.-]+$/i.test(src)) return src
  // Rule: bare figure_N.jpg → absolute URL from nearest preceding @part src
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const imgRe = new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`)
  const idx = markdown.search(imgRe)
  const scope = idx >= 0 ? markdown.slice(0, idx) : markdown
  const srcs = [...scope.matchAll(/src="(\/imports\/page-ocr\/[^"]+)"/g)]
  const last = srcs[srcs.length - 1]?.[1]
  if (!last) return src
  const m = /(\/imports\/page-ocr\/[^/]+\/)p(\d+)/.exec(last)
  if (!m) return src
  const pn = m[2]!.padStart(2, '0')
  const fname = src.startsWith(`p${pn}_`) ? src : `p${pn}_${src}`
  return `${m[1]}${fname}`
}

function makePreviewImg(markdown: string) {
  return function PreviewImg({
    src,
    alt,
    ...props
  }: React.ComponentPropsWithoutRef<'img'>) {
    const resolved = resolveRelativeFigureSrc(src, markdown)
    const a = alt ?? ''
    const isFigure =
      typeof resolved === 'string' &&
      (resolved.includes('figure') ||
        resolved.includes('table') ||
        a.startsWith('figure') ||
        a.startsWith('table'))
    const side =
      a.startsWith('figure-right') || a === 'figure-right'
        ? 'right'
        : a.startsWith('table-block') || a === 'table-block'
          ? 'table'
          : a.startsWith('figure-block') || a === 'figure-block'
            ? 'block'
            : isFigure
              ? 'block'
              : ''
    if (!isFigure) {
      return <img {...props} src={resolved || src} alt={a} />
    }
    return (
      <img
        {...props}
        src={resolved || src}
        alt={a}
        className={
          side === 'right'
            ? 'preview-figure figure-right'
            : side === 'table'
              ? 'preview-figure table-block'
              : 'preview-figure figure-block'
        }
      />
    )
  }
}

function QuestionParagraph({
  children,
  ...props
}: React.ComponentPropsWithoutRef<'p'>) {
  // Hidden list separator between I–III and A–D (see prepareMarkdownForPreview)
  const only = Children.toArray(children)
  if (
    only.length === 1 &&
    typeof only[0] === 'string' &&
    only[0].replace(/\u200b/g, '').trim() === ''
  ) {
    return <p {...props} className="list-sep" aria-hidden="true" />
  }
  const q = splitLeadingLabel(children, QUESTION_NUMBER)
  if (q) {
    return (
      <p {...props} className="q-stem">
        <span className="q-num">{q.label}</span>
        <span className="q-body">{q.body}</span>
      </p>
    )
  }
  return <p {...props}>{children}</p>
}

export default function App() {
  const [markdown, setMarkdown] = useState(SAMPLE)
  const [editorCursor, setEditorCursor] = useState(0)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<string | null>(null)
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>('page')
  /** Staged PDF for page-picker OCR (same UX as sample). */
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfPageCount, setPdfPageCount] = useState(0)
  const [pdfPage, setPdfPage] = useState(1)
  const [lastOcrSlug, setLastOcrSlug] = useState<string | null>(null)
  /** Analysis from last OCR, keyed by `${slug}:${page}` — used for layout re-run. */
  const [analysisCache, setAnalysisCache] = useState<
    Record<
      string,
      {
        blocks: unknown[]
        width?: number
        height?: number
        formulas?: { kind?: string; box?: number[]; text?: string }[]
      }
    >
  >({})
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [layoutTrainPairs, setLayoutTrainPairs] = useState(0)
  /** When true: full OCR stream (no edit pause). When false: detect → edit → continue. */
  const [skipLayoutEdit, setSkipLayoutEdit] = useState(false)
  const [detectSession, setDetectSession] = useState<{
    slug: string
    page: number
    source_url: string
    width: number
    height: number
    layout: LayoutRegionEdit[]
    mfd: MfdRegionEdit[]
  } | null>(null)
  const [trainingQueue, setTrainingQueue] = useState<{
    file: File
    pages: number[]
    index: number
    slug?: string
    upsert?: boolean
    replaceAll?: boolean
  } | null>(null)
  const [sampleManifest, setSampleManifest] = useState<SampleManifest | null>(
    null,
  )
  const [samplePage, setSamplePage] = useState(1)
  const [samplePreviewOpen, setSamplePreviewOpen] = useState(true)
  const [cropModalOpen, setCropModalOpen] = useState(false)
  /** FAB page pick (non-sample); null = follow editor cursor */
  const [cropPagePick, setCropPagePick] = useState<number | null>(null)

  /** Leave sample paper mode only after a real uploaded OCR result. */
  function enterUploadedDocMode(slug?: string | null) {
    if (!slug) return
    setSampleManifest(null)
    setSamplePreviewOpen(true)
    setLastOcrSlug(slug)
    setCropPagePick((prev) => prev ?? pdfPage ?? 1)
  }

  async function restoreSampleMode() {
    try {
      const m = await loadSampleManifest(SAMPLE_PAPER_ID)
      setSampleManifest(m)
      if (m.pages.length > 0) setSamplePage(m.pages[0]!.page)
      setLastOcrSlug(m.id)
      setCropPagePick(null)
      setSamplePreviewOpen(true)
      await stageSamplePdf(m)
      return m
    } catch {
      setSampleManifest(null)
      return null
    }
  }

  /** Stage sample source PDF as the default Choose-file selection. */
  async function stageSamplePdf(m: SampleManifest) {
    if (!m.source_pdf) {
      setPdfFile(null)
      setPdfPageCount(0)
      return
    }
    try {
      const file = await fetchSamplePdfFile(m.id, m.source_pdf)
      setPdfFile(file)
      try {
        const meta = await fetchPdfMeta(file)
        setPdfPageCount(meta.pages)
      } catch {
        // API down — still show the file as chosen; use PNG page count
        setPdfPageCount(m.pages.length || 15)
      }
      setPdfPage(1)
    } catch (err) {
      setPdfFile(null)
      setPdfPageCount(0)
      console.warn('Sample PDF staging failed', err)
    }
  }

  const [hoksiUrl, setHoksiUrl] = useState(DEFAULT_HOKSI)
  const [hoksiLang, setHoksiLang] = useState<HoksiLang>('zh-HK')
  const [hoksiBusy, setHoksiBusy] = useState(false)
  const [hoksiStatus, setHoksiStatus] = useState<string | null>(null)
  const [hoksiArticles, setHoksiArticles] = useState<HoksiArticleRef[]>([])
  const [hoksiSelected, setHoksiSelected] = useState('')

  async function refreshHoksiList(slug: string, lang: HoksiLang) {
    const { articles, dir } = await listHoksiArticles(slug, lang)
    setHoksiArticles(articles)
    const first = articles[0]?.rel || ''
    setHoksiSelected(first)
    if (articles.length > 0) {
      setHoksiStatus(
        `Found ${articles.length} ${lang} article(s) under ${dir || `downloads/hoksi/${slug}/${lang}`}/`,
      )
    } else {
      setHoksiStatus(`No ${lang} articles saved yet — click Download Hoksi.`)
    }
    return { articles, first }
  }

  useEffect(() => {
    const slug = parseHoksiSlug(DEFAULT_HOKSI)
    void refreshHoksiList(slug, 'zh-HK').catch(() => {
      /* ignore — nothing saved yet */
    })
  }, [])

  useEffect(() => {
    if (!cropModalOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCropModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [cropModalOpen])

  useEffect(() => {
    void loadSampleManifest(SAMPLE_PAPER_ID)
      .then(async (m) => {
        setSampleManifest(m)
        if (m.pages.length > 0) setSamplePage(m.pages[0]!.page)
        setLastOcrSlug(m.id)
        await stageSamplePdf(m)
        // Refresh from public draft if present (keeps src/samples in sync)
        if (m.ocr_md) {
          try {
            const md = await fetchSampleOcrDraft(m.id, m.ocr_md)
            setMarkdown(normalizeMathDelimiters(md.trim()) + '\n')
            setOcrStatus(
              `Sample paper loaded (p.1–${m.pages.length})` +
                (m.source_pdf ? ` · PDF ready` : ''),
            )
          } catch {
            setOcrStatus(`Sample paper loaded (bundled draft)`)
          }
        }
      })
      .catch(() => setSampleManifest(null))
  }, [])

  async function onImportWord(file: File | undefined) {
    if (!file) return
    setImporting(true)
    setImportStatus(null)
    try {
      const {
        markdown: md,
        messages,
        equationCount,
        mathtypeCount,
        imageCount,
        imageDir,
      } = await wordFileToMarkdown(file)
      setMarkdown(normalizeMathDelimiters(md))
      const parts: string[] = [`Imported “${file.name}”.`]
      if (equationCount > 0) {
        parts.push(
          `${equationCount} Word equation${equationCount === 1 ? '' : 's'} → LaTeX.`,
        )
      }
      if (mathtypeCount > 0) {
        parts.push(
          `${mathtypeCount} MathType OLE left — run Tools/mathtype_docx_to_latex.py first.`,
        )
      }
      if (imageCount > 0) {
        parts.push(`${imageCount} image(s) → ${imageDir ?? 'imports/'}.`)
      }
      if (equationCount === 0 && mathtypeCount === 0 && imageCount === 0) {
        parts.push(messages[messages.length - 1] ?? 'Done.')
      }
      setImportStatus(parts.join(' '))
    } catch (err) {
      setImportStatus(
        err instanceof Error ? `Import failed: ${err.message}` : 'Import failed.',
      )
    } finally {
      setImporting(false)
    }
  }

  async function onDownloadHoksi() {
    setHoksiBusy(true)
    setHoksiStatus('Starting…')
    try {
      const result = await downloadHoksiTopic(
        hoksiUrl,
        (p) => {
          if ('message' in p) setHoksiStatus(p.message)
          else setHoksiStatus(`Downloading ${p.i}/${p.n}: ${p.name}`)
        },
        hoksiLang,
      )
      const lang = (result.lang as HoksiLang) || hoksiLang
      const { articles, first } = await refreshHoksiList(result.slug, lang)
      setHoksiStatus(
        `Saved ${articles.length} ${lang} article(s) → ${result.dir}/  (${result.name})`,
      )
      if (first) {
        const md = await readHoksiArticle(first)
        setMarkdown(normalizeMathDelimiters(md))
      }
    } catch (err) {
      setHoksiStatus(
        err instanceof Error
          ? `Hoksi download failed: ${err.message}`
          : 'Hoksi download failed.',
      )
    } finally {
      setHoksiBusy(false)
    }
  }

  async function onChangeHoksiLang(lang: HoksiLang) {
    setHoksiLang(lang)
    // Keep URL lang segment in sync when it's a full Hoksi URL
    setHoksiUrl((prev) =>
      prev.replace(
        /hoksiresources\.com\/(en|zh-HK|zh-TW|zh)(\/|$)/i,
        `hoksiresources.com/${lang}$2`,
      ),
    )
    const slug = parseHoksiSlug(hoksiUrl)
    try {
      const { first } = await refreshHoksiList(slug, lang)
      if (first) {
        const md = await readHoksiArticle(first)
        setMarkdown(normalizeMathDelimiters(md))
      } else {
        setMarkdown(SAMPLE)
      }
    } catch {
      setHoksiArticles([])
      setHoksiSelected('')
    }
  }

  async function runPagePipeline(
    file: File,
    opts: {
      pages?: string
      pageNo?: number
      upsert?: boolean
      statusLabel?: string
      slug?: string
      replaceAll?: boolean
    } = {},
  ) {
    if (!skipLayoutEdit) {
      await startTrainingDetect(file, opts)
      return
    }
    setOcrBusy(true)
    const pagesSpec = opts.pages?.trim() || undefined
    const label = opts.statusLabel || file.name
    setOcrStatus(`OCR “${label}” (page pipeline)…`)
    try {
      const page = await ocrPageToMarkdown(file, {
        pages: pagesSpec,
        slug: opts.slug,
        onProgress: ({ page: n, total, phase }) => {
          if (n === 0) {
            setOcrStatus(`OCR PDF · ${total} page${total === 1 ? '' : 's'}…`)
            return
          }
          const step =
            phase === 'render'
              ? `rendering ${n}/${total}`
              : phase === 'done'
                ? `done ${n}/${total}`
                : `page ${n}/${total}`
          setOcrStatus(`OCR PDF · ${step}…`)
        },
      })
      if (page.slug) {
        enterUploadedDocMode(page.slug)
      }
      const analyses = page.analysis
        ? Array.isArray(page.analysis)
          ? page.analysis
          : [page.analysis]
        : []
      if (page.slug && analyses.length) {
        setAnalysisCache((prev) => {
          const next = { ...prev }
          for (const a of analyses) {
            const pno = Number(
              (a as { page?: number }).page ?? opts.pageNo ?? 1,
            )
            next[`${page.slug}:${pno}`] = {
              blocks: (a as { blocks?: unknown[] }).blocks || [],
              width: (a as { width?: number }).width,
              height: (a as { height?: number }).height,
              formulas: (a as { formulas?: { box?: number[] }[] }).formulas,
            }
          }
          return next
        })
      }
      const textMd = normalizeMathDelimiters(page.markdown.trim())
      if (!textMd) throw new Error('OCR returned empty markdown.')
      if (opts.upsert && opts.pageNo != null) {
        setMarkdown((prev) => upsertPageMarkdown(prev, opts.pageNo!, textMd))
        setCropPagePick(opts.pageNo)
      } else {
        setMarkdown(textMd + '\n')
        setCropPagePick(opts.pageNo ?? 1)
      }
      setOcrStatus(
        `Draft ready · ${page.pages} page${page.pages === 1 ? '' : 's'}` +
          (opts.upsert && opts.pageNo != null
            ? ` · upserted p.${opts.pageNo} — edit layout / Re-run OCR`
            : ' — edit layout below / Re-run OCR'),
      )
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Page OCR failed')
    } finally {
      setOcrBusy(false)
    }
  }

  async function resolveTrainingPages(
    file: File,
    opts: { pages?: string; pageNo?: number },
  ): Promise<number[]> {
    if (opts.pageNo != null && opts.pageNo >= 1) return [opts.pageNo]
    const spec = (opts.pages || '').trim()
    if (spec && /^\d+$/.test(spec)) return [Number(spec)]
    if (spec && spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number)
      if (a && b && b >= a) {
        return Array.from({ length: b - a + 1 }, (_, i) => a + i)
      }
    }
    if (file.name.toLowerCase().endsWith('.pdf') || file.type.includes('pdf')) {
      try {
        const meta = await fetchPdfMeta(file)
        if (spec === 'all' || !spec) {
          return Array.from({ length: Math.min(meta.pages, 40) }, (_, i) => i + 1)
        }
      } catch {
        /* fall through */
      }
    }
    return [1]
  }

  async function startTrainingDetect(
    file: File,
    opts: {
      pages?: string
      pageNo?: number
      upsert?: boolean
      statusLabel?: string
      slug?: string
      replaceAll?: boolean
    } = {},
  ) {
    setOcrBusy(true)
    setOcrStatus('Detect layout+MFD (training mode)…')
    try {
      const pages = await resolveTrainingPages(file, opts)
      const queue = {
        file,
        pages,
        index: 0,
        slug: opts.slug,
        upsert: opts.upsert,
        replaceAll: opts.replaceAll,
      }
      setTrainingQueue(queue)
      await detectTrainingPage(queue)
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Detect failed')
      setOcrBusy(false)
      setTrainingQueue(null)
    }
  }

  async function detectTrainingPage(queue: {
    file: File
    pages: number[]
    index: number
    slug?: string
    upsert?: boolean
    replaceAll?: boolean
  }) {
    const pageNo = queue.pages[queue.index]
    if (pageNo == null) {
      setOcrBusy(false)
      setTrainingQueue(null)
      setDetectSession(null)
      return
    }
    setOcrBusy(true)
    setOcrStatus(
      `Detect p.${pageNo} (${queue.index + 1}/${queue.pages.length}) — edit layout+MFD…`,
    )
    try {
      const det = await detectPageLayoutMfd(queue.file, {
        page: pageNo,
        slug: queue.slug,
      })
      if (det.slug) {
        if (!sampleManifest || det.slug !== sampleManifest.id) {
          enterUploadedDocMode(det.slug)
        } else {
          setLastOcrSlug(det.slug)
        }
        setTrainingQueue({ ...queue, slug: det.slug })
      }
      const layout: LayoutRegionEdit[] = (det.layout || []).map((r) => ({
        kind: (['title', 'text', 'figure', 'table', 'formula', 'ignored'].includes(
          (r.kind || 'text').toLowerCase(),
        )
          ? (r.kind || 'text').toLowerCase()
          : 'text') as LayoutRegionEdit['kind'],
        box: r.box,
        score: r.score,
      }))
      const mfd: MfdRegionEdit[] = (det.mfd || []).map((m) => ({
        type: m.type === 'isolated' ? 'isolated' : 'embedding',
        box: m.box,
        score: m.score,
      }))
      const pad = String(det.page).padStart(2, '0')
      const src =
        det.source_url ||
        `/imports/page-ocr/${det.slug}/p${pad}_source.png`
      setDetectSession({
        slug: det.slug,
        page: det.page,
        source_url: `${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`,
        width: det.width,
        height: det.height,
        layout,
        mfd,
      })
      setCropPagePick(det.page)
      setCropModalOpen(true)
      setOcrStatus(
        `Edit layout+MFD for p.${det.page}, then Confirm & continue OCR`,
      )
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Detect failed')
      setTrainingQueue(null)
      setDetectSession(null)
    } finally {
      setOcrBusy(false)
    }
  }

  async function onConfirmContinue(
    layout: LayoutRegionEdit[],
    mfd: MfdRegionEdit[],
  ) {
    if (!detectSession) return
    setLayoutBusy(true)
    setOcrStatus(`Finishing OCR p.${detectSession.page} (retrain layout+MFD)…`)
    try {
      const result = await continuePageOcr({
        slug: detectSession.slug,
        page: detectSession.page,
        source_url: detectSession.source_url,
        width: detectSession.width,
        height: detectSession.height,
        layout: layout.map((r) => ({
          kind: r.kind,
          box: r.box,
          score: r.score,
        })),
        mfd: mfd.map((m) => ({
          type: m.type,
          box: m.box,
          score: m.score,
        })),
      })
      const pageMd = normalizeMathDelimiters(result.markdown.trim())
      const q = trainingQueue
      if (q?.replaceAll && q.index === 0) {
        setMarkdown(pageMd + '\n')
      } else {
        setMarkdown((prev) =>
          upsertPageMarkdown(prev, detectSession.page, pageMd),
        )
      }
      const parts: string[] = [`OCR done p.${detectSession.page}`]
      if (result.auto_retrain_layout?.queued) parts.push('layout retrain queued')
      if (result.auto_retrain_mfd?.queued) parts.push('MFD retrain queued')
      setOcrStatus(parts.join(' · '))
      void pollLayoutTrain()

      setDetectSession(null)
      setCropModalOpen(false)

      if (q && q.index + 1 < q.pages.length) {
        const next = { ...q, index: q.index + 1, slug: detectSession.slug }
        setTrainingQueue(next)
        await detectTrainingPage(next)
      } else {
        setTrainingQueue(null)
        setOcrStatus(`${parts.join(' · ')} · training queue done`)
      }
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Continue OCR failed')
    } finally {
      setLayoutBusy(false)
    }
  }

  async function onOcrImage(file: File | undefined) {
    if (!file) return
    if (ocrEngine === 'page') {
      const isPdf =
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf')
      if (isPdf) {
        setOcrBusy(true)
        setOcrStatus(`Reading PDF “${file.name}”…`)
        try {
          const meta = await fetchPdfMeta(file)
          setPdfFile(file)
          setPdfPageCount(meta.pages)
          setPdfPage(1)
          setOcrStatus(
            `PDF ready · ${meta.pages} page${meta.pages === 1 ? '' : 's'} — pick a page, then OCR`,
          )
        } catch (err) {
          setPdfFile(null)
          setPdfPageCount(0)
          setOcrStatus(
            err instanceof Error
              ? `PDF failed: ${err.message}`
              : 'Could not read PDF.',
          )
        } finally {
          setOcrBusy(false)
        }
        return
      }
      await runPagePipeline(file, { statusLabel: file.name })
      return
    }

    setOcrBusy(true)
    setOcrStatus(`OCR “${file.name}” (${ocrEngine})…`)
    try {
      const { latex, markdown: snip, engine: eng } = await ocrImageToMarkdown(
        file,
        ocrEngine,
      )
      const textMd = (snip || '').trim()
      if (!textMd) {
        throw new Error('OCR returned empty markdown.')
      }
      setMarkdown(
        (prev) =>
          `${prev.trimEnd()}\n\n${normalizeMathDelimiters(textMd)}\n`,
      )
      setOcrStatus(`OCR [${eng}] → ${latex}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OCR failed.'
      setOcrStatus(`OCR failed: ${msg}`)
    } finally {
      setOcrBusy(false)
    }
  }

  async function onOcrPdfPage() {
    if (!pdfFile || pdfPageCount < 1) return
    await runPagePipeline(pdfFile, {
      pages: String(pdfPage),
      pageNo: pdfPage,
      upsert: true,
      statusLabel: `${pdfFile.name} p.${pdfPage}`,
    })
    if (pdfPage < pdfPageCount) {
      setPdfPage((p) => Math.min(pdfPageCount, p + 1))
    }
  }

  async function onLoadSampleOcrDraft() {
    if (!sampleManifest?.ocr_md) {
      setOcrStatus('No precomputed OCR draft in sample manifest')
      return
    }
    setOcrBusy(true)
    try {
      const md = await fetchSampleOcrDraft(
        sampleManifest.id,
        sampleManifest.ocr_md,
      )
      setMarkdown(normalizeMathDelimiters(md.trim()) + '\n')
      setOcrStatus(`Loaded sample OCR draft (${sampleManifest.ocr_md})`)
    } catch (err) {
      setOcrStatus(
        err instanceof Error ? err.message : 'Failed to load OCR draft',
      )
    } finally {
      setOcrBusy(false)
    }
  }

  async function onOcrSamplePage(mode: 'append' | 'replace') {
    if (!sampleManifest) return
    const entry = sampleManifest.pages.find((p) => p.page === samplePage)
    if (!entry) {
      setOcrStatus(`Sample page ${samplePage} not found`)
      return
    }
    setLastOcrSlug(sampleManifest.id)
    try {
      const file = await fetchSamplePageFile(
        sampleManifest.id,
        entry.file,
        samplePage,
      )
      if (!skipLayoutEdit) {
        await startTrainingDetect(file, {
          pageNo: samplePage,
          slug: sampleManifest.id,
          upsert: mode === 'append',
          replaceAll: mode === 'replace',
          statusLabel: `sample p.${samplePage}`,
        })
        return
      }
      setOcrBusy(true)
      setOcrStatus(`Live OCR sample p.${samplePage}…`)
      const page = await ocrPageToMarkdown(file, {
        page: samplePage,
        slug: sampleManifest.id,
        onProgress: ({ page: n, total, phase }) => {
          setOcrStatus(
            `OCR sample p.${samplePage} · ${phase} ${n}/${total}…`,
          )
        },
      })
      if (page.slug) setLastOcrSlug(page.slug)
      else setLastOcrSlug(sampleManifest.id)
      const analyses = page.analysis
        ? Array.isArray(page.analysis)
          ? page.analysis
          : [page.analysis]
        : []
      if (analyses.length) {
        setAnalysisCache((prev) => {
          const next = { ...prev }
          for (const a of analyses) {
            const pno = Number((a as { page?: number }).page ?? samplePage)
            const blocks = (a as { blocks?: unknown[] }).blocks || []
            next[`${page.slug || sampleManifest.id}:${pno}`] = {
              blocks,
              width: (a as { width?: number }).width,
              height: (a as { height?: number }).height,
              formulas: (a as { formulas?: { box?: number[] }[] }).formulas,
            }
          }
          return next
        })
      }
      const text = normalizeMathDelimiters(page.markdown.trim())
      if (!text) throw new Error('OCR returned empty markdown.')
      if (mode === 'replace') {
        setMarkdown(text + '\n')
      } else {
        setMarkdown((prev) => upsertPageMarkdown(prev, samplePage, text))
      }
      setOcrStatus(
        `Live OCR p.${samplePage} upserted — edit layout / Re-run OCR`,
      )
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Sample OCR failed')
    } finally {
      setOcrBusy(false)
    }
  }

  /** Active OCR slug for the document currently in the editor (not hardcoded sample). */
  function slugFromPartSrc(src: string | undefined | null): string | null {
    if (!src) return null
    const m = /\/(?:samples|imports\/page-ocr|page-ocr)\/([^/]+)/.exec(src)
    return m?.[1] ?? null
  }

  const editorParts = parseDocParts(markdown)
  const docSlugFromMarkdown =
    slugFromPartSrc(
      editorParts.find((p) => p.page === (cropPagePick ?? samplePage) && p.src)
        ?.src,
    ) ||
    slugFromPartSrc(editorParts.find((p) => p.src)?.src) ||
    null

  /** Sample UI only when the editor is still on the sample paper. */
  const usingSampleDoc = (() => {
    if (!sampleManifest) return false
    // A finished upload OCR always wins over the sample toolbar
    if (lastOcrSlug && lastOcrSlug !== sampleManifest.id) return false
    if (docSlugFromMarkdown && docSlugFromMarkdown !== sampleManifest.id) {
      return false
    }
    return true
  })()

  const activeDocSlug =
    (lastOcrSlug && lastOcrSlug !== SAMPLE_PAPER_ID ? lastOcrSlug : null) ||
    (docSlugFromMarkdown && docSlugFromMarkdown !== SAMPLE_PAPER_ID
      ? docSlugFromMarkdown
      : null) ||
    docSlugFromMarkdown ||
    lastOcrSlug ||
    sampleManifest?.id ||
    null

  const cropPage = usingSampleDoc
    ? samplePage
    : cropPagePick ??
      (() => {
        const at =
          editorParts.find((p) => p.index <= editorCursor) || editorParts[0]
        return at?.page ?? pdfPage ?? 1
      })()

  const cropPageOptions: number[] = (() => {
    const raw = usingSampleDoc
      ? sampleManifest!.pages.map((p) => p.page)
      : (() => {
          const fromMd = [
            ...new Set(
              [...markdown.matchAll(/^## Page (\d+)\b/gm)].map((m) =>
                Number(m[1]),
              ),
            ),
          ].sort((a, b) => a - b)
          if (fromMd.length) return fromMd
          if (pdfPageCount > 0) {
            return Array.from({ length: pdfPageCount }, (_, i) => i + 1)
          }
          return [] as number[]
        })()
    if (cropPage && !raw.includes(cropPage)) {
      return [...raw, cropPage].sort((a, b) => a - b)
    }
    return raw.length ? raw : [cropPage || 1]
  })()

  function setCropPage(page: number) {
    if (usingSampleDoc) setSamplePage(page)
    else {
      setCropPagePick(page)
      if (pdfFile && pdfPageCount > 0) setPdfPage(page)
    }
  }

  const cropImageSrc = (() => {
    if (detectSession?.source_url) return detectSession.source_url
    const pad = String(cropPage).padStart(2, '0')
    // Always prefer the page image referenced by the current markdown
    const part = editorParts.find((p) => p.page === cropPage && p.src)
    if (part?.src) return part.src
    if (activeDocSlug) {
      return `/imports/page-ocr/${activeDocSlug}/p${pad}_source.png`
    }
    if (usingSampleDoc && sampleManifest) {
      return `/samples/${sampleManifest.id}/p${pad}.png`
    }
    return ''
  })()

  // If image is gone, clear modal flag so the page+Edit FAB never vanishes
  useEffect(() => {
    if (cropModalOpen && !cropImageSrc && !detectSession) setCropModalOpen(false)
  }, [cropModalOpen, cropImageSrc, detectSession])

  useEffect(() => {
    void fetchLayoutStatus()
      .then((s) => setLayoutTrainPairs(s.train_list ?? s.images ?? 0))
      .catch(() => {})
  }, [])

  async function onSaveLayout(regions: LayoutRegionEdit[]) {
    const slug =
      activeDocSlug ||
      slugFromPartSrc(
        parseDocParts(markdown).find((p) => p.page === cropPage && p.src)?.src,
      ) ||
      lastOcrSlug ||
      sampleManifest?.id ||
      null
    if (!slug) {
      setOcrStatus('Load an OCR import first')
      return
    }
    let width = analysisCache[`${slug}:${cropPage}`]?.width
    let height = analysisCache[`${slug}:${cropPage}`]?.height
    if (!width || !height) {
      try {
        const analysis = await fetchPageAnalysis(slug, cropPage)
        width = analysis.width
        height = analysis.height
      } catch {
        /* ignore */
      }
    }
    if (!width || !height) {
      setOcrStatus('Missing page size — OCR this page once first')
      return
    }
    setLayoutBusy(true)
    setOcrStatus(`Saving layout for p.${cropPage}…`)
    try {
      const part = parseDocParts(markdown).find((p) => p.page === cropPage && p.src)
      const result = await saveLayoutCorrection({
        slug,
        page: cropPage,
        width,
        height,
        regions,
        source_url: part?.src || cropImageSrc,
      })
      setLayoutTrainPairs(result.train_pairs ?? layoutTrainPairs)
      const auto = result.auto_retrain
      if (auto?.queued) {
        setOcrStatus(
          `Layout saved p.${cropPage} · auto-retrain ${auto.already_running ? 'queued' : 'started'} (${auto.epochs ?? '?'} ep, ${result.train_pairs ?? '?'} pages)`,
        )
        void pollLayoutTrain()
      } else {
        setOcrStatus(
          `Layout saved p.${cropPage} (${result.regions ?? regions.length} regions${auto?.reason ? ` · retrain: ${auto.reason}` : ''})`,
        )
      }
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Save layout failed')
    } finally {
      setLayoutBusy(false)
    }
  }

  async function pollLayoutTrain() {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        const s = await fetchLayoutStatus()
        setLayoutTrainPairs(s.train_list ?? s.images ?? 0)
        const mfdRun = s.mfd_train_running || s.mfd?.train_running
        if (s.train_running || s.train_pending || mfdRun) {
          setOcrStatus(
            `Auto-retrain… layout=${s.train_running ? 'run' : 'idle'} mfd=${mfdRun ? 'run' : 'idle'} (${s.train_list ?? 0}/${s.mfd_train_list ?? s.mfd?.train_list ?? 0} pages)`,
          )
          continue
        }
        const bits: string[] = []
        if (s.train_last_ok === true) bits.push('layout OK')
        if (s.train_last_ok === false)
          bits.push(`layout fail: ${s.train_last_error || '?'}`)
        if (s.mfd?.train_last_ok === true) bits.push('MFD OK')
        if (s.mfd?.train_last_ok === false)
          bits.push(`MFD fail: ${s.mfd.train_last_error || '?'}`)
        if (bits.length) setOcrStatus(`Auto-retrain done — ${bits.join(' · ')}`)
        break
      } catch {
        break
      }
    }
  }

  async function onRerunWithLayout(
    regions: LayoutRegionEdit[],
    mfd: MfdRegionEdit[] = [],
  ) {
    const slug =
      activeDocSlug ||
      slugFromPartSrc(
        parseDocParts(markdown).find((p) => p.page === cropPage && p.src)?.src,
      ) ||
      lastOcrSlug ||
      sampleManifest?.id ||
      null
    if (!slug) {
      setOcrStatus('Load an OCR import first')
      return
    }
    setLayoutBusy(true)
    setOcrStatus(
      `Re-running OCR p.${cropPage} with corrected layout${mfd.length ? ` + ${mfd.length} MFD` : ''}…`,
    )
    try {
      const part = parseDocParts(markdown).find((p) => p.page === cropPage && p.src)
      const { markdown: pageMd, combined_markdown: combined } =
        await rerunPageWithLayout({
          slug,
          page: cropPage,
          source_url: part?.src || cropImageSrc,
          regions: regions.map((r) => ({
            kind: r.kind,
            box: r.box,
            score: r.score ?? 1,
          })),
          mfd: mfd.map((m) => ({
            box: m.box,
            type: m.type,
            score: m.score,
          })),
        })
      const next = combined
        ? combined
        : upsertPageMarkdown(markdown, cropPage, pageMd)
      setMarkdown(next)
      setOcrStatus(`Layout re-run done p.${cropPage} — preview updated`)
      setCropModalOpen(false)
      try {
        const analysis = await fetchPageAnalysis(slug, cropPage)
        setAnalysisCache((prev) => ({
          ...prev,
          [`${slug}:${cropPage}`]: {
            blocks: analysis.blocks || [],
            width: analysis.width,
            height: analysis.height,
            formulas: analysis.formulas,
          },
        }))
      } catch {
        /* ignore */
      }
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Layout re-run failed')
    } finally {
      setLayoutBusy(false)
    }
  }

  async function onTrainLayout() {
    setLayoutBusy(true)
    setOcrStatus('Queuing DocLayout-YOLO train…')
    try {
      const result = await trainLayoutModel({ epochs: 20, async: true })
      if (result.queued) {
        setOcrStatus(
          `Train queued (${result.reason || 'manual'}) — running in background`,
        )
        void pollLayoutTrain()
      } else {
        setOcrStatus(result.hint || 'Train finished')
      }
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'Train layout failed')
    } finally {
      setLayoutBusy(false)
    }
  }

  async function onOpenHoksiArticle(rel: string) {
    setHoksiSelected(rel)
    if (!rel) return
    try {
      const md = await readHoksiArticle(rel)
      setMarkdown(normalizeMathDelimiters(md))
      setHoksiStatus(`Opened ${rel}`)
    } catch (err) {
      setHoksiStatus(
        err instanceof Error ? err.message : 'Failed to open article.',
      )
    }
  }

  const preview = useMemo(
    () => (
      <Markdown
        remarkPlugins={[
          remarkGfm,
          remarkBreaks,
          // Inline math only via \(…\)→$$…$$; never bare $abd$ (breaks \$36…\$6)
          [remarkMath, { singleDollarTextMath: false }],
        ]}
        rehypePlugins={[
          [
            rehypeMathjax,
            {
              chtml: {
                fontURL:
                  'https://cdn.jsdelivr.net/npm/mathjax@3/es5/output/chtml/fonts/woff-v2',
                scale: 1,
              },
              tex: {
                inlineMath: [['\\(', '\\)']],
                displayMath: [
                  ['$$', '$$'],
                  ['\\[', '\\]'],
                ],
                processEscapes: true,
              },
            },
          ],
        ]}
        components={{
          li: McqListItem,
          p: QuestionParagraph,
          ul: PreviewUl,
          img: makePreviewImg(markdown),
        }}
      >
        {prepareMarkdownForPreview(markdown)}
      </Markdown>
    ),
    [markdown],
  )

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="brand">AlphaEqt Content</p>
          <h1>Markdown + preview</h1>
        </div>
        <p className="hint">
          Inline math: <code>{'\\(...\\)'}</code> · Display:{' '}
          <code>{'$$...$$'}</code> · Currency: <code>{'\\$36'}</code> · MCQ{' '}
          <code>A.</code>–<code>D.</code>
          <br />
          Type MD, import Word, OCR, or download from Hoksi.
          {importStatus ? (
            <>
              <br />
              <span className="import-status">{importStatus}</span>
            </>
          ) : null}
          {ocrStatus ? (
            <>
              <br />
              <span className="import-status">{ocrStatus}</span>
            </>
          ) : null}
          {hoksiStatus ? (
            <>
              <br />
              <span className="import-status">{hoksiStatus}</span>
            </>
          ) : null}
        </p>
      </header>

      <section className="import-bar">
        <label className="import-field">
          <span>Hoksi topic URL / slug</span>
          <input
            type="text"
            value={hoksiUrl}
            disabled={hoksiBusy}
            onChange={(e) => {
              const v = e.target.value
              setHoksiUrl(v)
              setHoksiLang(parseHoksiLang(v, hoksiLang))
            }}
            placeholder={DEFAULT_HOKSI}
          />
        </label>
        <label className="import-field import-field-lang">
          <span>Language</span>
          <select
            value={hoksiLang}
            disabled={hoksiBusy}
            onChange={(e) => void onChangeHoksiLang(e.target.value as HoksiLang)}
          >
            <option value="zh-HK">中文 (zh-HK)</option>
            <option value="en">English (en)</option>
          </select>
        </label>
        <button
          type="button"
          className={hoksiBusy ? 'is-busy' : ''}
          disabled={hoksiBusy || !hoksiUrl.trim()}
          onClick={() => void onDownloadHoksi()}
        >
          {hoksiBusy ? 'Downloading…' : 'Download Hoksi'}
        </button>
        {hoksiArticles.length > 0 ? (
          <label className="import-field import-field-grow">
            <span>
              Open article ({hoksiArticles.length} · {hoksiLang})
            </span>
            <select
              value={hoksiSelected}
              disabled={hoksiBusy}
              onChange={(e) => void onOpenHoksiArticle(e.target.value)}
            >
              {hoksiArticles.map((a) => (
                <option key={a.rel} value={a.rel}>
                  {a.folder} — {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      <main className="panes">
        <section className="pane">
          <div className="pane-head">
            <h2>Editor</h2>
            <div className="pane-actions">
              <select
                className="engine-select"
                value={ocrEngine}
                disabled={ocrBusy}
                aria-label="OCR engine"
                onChange={(e) => setOcrEngine(e.target.value as OcrEngine)}
              >
                <option value="page">Page pipeline</option>
                <option value="unimernet">UniMERNet crop</option>
                <option value="pix2tex">pix2tex crop</option>
              </select>
              {ocrEngine === 'page' ? (
                <label
                  className="train-mode-toggle"
                  title={
                    skipLayoutEdit
                      ? 'Production: full OCR without layout+MFD edit pause'
                      : 'Training: detect → edit layout+MFD → finish OCR (retrain only when asked)'
                  }
                >
                  <input
                    type="checkbox"
                    checked={skipLayoutEdit}
                    disabled={ocrBusy || layoutBusy}
                    onChange={(e) => setSkipLayoutEdit(e.target.checked)}
                  />
                  Skip layout+MFD edit
                </label>
              ) : null}
              {ocrEngine === 'page' && pdfFile && pdfPageCount > 0 ? (
                <div className="sample-ocr pdf-ocr">
                  <label className="sample-page-pick">
                    <span title={pdfFile.name}>PDF</span>
                    <select
                      value={pdfPage}
                      disabled={ocrBusy}
                      aria-label="PDF page"
                      onChange={(e) => setPdfPage(Number(e.target.value))}
                    >
                      {Array.from({ length: pdfPageCount }, (_, i) => i + 1).map(
                        (n) => (
                          <option key={n} value={n}>
                            p.{n}/{pdfPageCount}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={ocrBusy}
                    title="OCR this PDF page and merge into the editor"
                    onClick={() => void onOcrPdfPage()}
                  >
                    {ocrBusy ? 'OCR…' : `OCR p.${pdfPage}`}
                  </button>
                  <button
                    type="button"
                    className="crop-open-toolbar"
                    disabled={!cropImageSrc}
                    title="Open layout + MFD editor"
                    onClick={() => setCropModalOpen(true)}
                  >
                    Edit layout
                  </button>
                  <button
                    type="button"
                    disabled={ocrBusy || pdfPage <= 1}
                    onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    disabled={ocrBusy || pdfPage >= pdfPageCount}
                    onClick={() =>
                      setPdfPage((p) => Math.min(pdfPageCount, p + 1))
                    }
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    disabled={ocrBusy}
                    title="Clear staged PDF"
                    onClick={() => {
                      setPdfFile(null)
                      setPdfPageCount(0)
                      setPdfPage(1)
                      setOcrStatus(null)
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : null}
              {usingSampleDoc && sampleManifest ? (
                <div className="sample-ocr">
                  <label className="sample-page-pick">
                    <span>Sample</span>
                    <select
                      value={samplePage}
                      disabled={ocrBusy}
                      aria-label="Sample page"
                      onChange={(e) => setSamplePage(Number(e.target.value))}
                    >
                      {sampleManifest.pages.map((p) => (
                        <option key={p.page} value={p.page}>
                          p.{p.page}/{sampleManifest.pages.length}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={ocrBusy}
                    title="Live OCR this sample page with pipeline rules"
                    onClick={() => void onOcrSamplePage('append')}
                  >
                    {ocrBusy ? 'OCR…' : `OCR p.${samplePage}`}
                  </button>
                  <button
                    type="button"
                    className="crop-open-toolbar"
                    disabled={!cropImageSrc}
                    title="Open layout + MFD editor (zoom / drag / Re-run OCR)"
                    onClick={() => setCropModalOpen(true)}
                  >
                    Edit layout
                  </button>
                  {sampleManifest.ocr_md ? (
                    <button
                      type="button"
                      disabled={ocrBusy}
                      title="Load saved OCR draft — no re-OCR"
                      onClick={() => void onLoadSampleOcrDraft()}
                    >
                      Load OCR draft
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={ocrBusy || samplePage <= 1}
                    onClick={() => setSamplePage((p) => Math.max(1, p - 1))}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    disabled={
                      ocrBusy || samplePage >= sampleManifest.pages.length
                    }
                    onClick={() =>
                      setSamplePage((p) =>
                        Math.min(sampleManifest.pages.length, p + 1),
                      )
                    }
                  >
                    ›
                  </button>
                </div>
              ) : null}
              <label
                className={`file-btn${ocrBusy ? ' is-busy' : ''}`}
                title={
                  ocrEngine === 'page' && pdfFile
                    ? pdfFile.name
                    : undefined
                }
              >
                {ocrBusy
                  ? 'OCR…'
                  : ocrEngine === 'page'
                    ? pdfFile
                      ? pdfFile.name
                      : 'Choose PDF / image'
                    : 'OCR image'}
                <input
                  type="file"
                  accept={
                    ocrEngine === 'page'
                      ? 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,application/pdf,.pdf'
                      : 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp'
                  }
                  disabled={ocrBusy}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    void onOcrImage(file)
                    e.target.value = ''
                  }}
                />
              </label>
              <label className={`file-btn${importing ? ' is-busy' : ''}`}>
                {importing ? 'Importing…' : 'Import Word'}
                <input
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={importing}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    void onImportWord(file)
                    e.target.value = ''
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const m = sampleManifest ?? (await restoreSampleMode())
                    if (!m) {
                      setMarkdown(normalizeMathDelimiters(SAMPLE.trim()) + '\n')
                      setLastOcrSlug(SAMPLE_PAPER_ID)
                      setOcrStatus('Reset to bundled sample draft')
                      return
                    }
                    setSamplePage(1)
                    setLastOcrSlug(m.id)
                    await stageSamplePdf(m)
                    if (m.ocr_md) {
                      try {
                        const md = await fetchSampleOcrDraft(m.id, m.ocr_md)
                        setMarkdown(normalizeMathDelimiters(md.trim()) + '\n')
                      } catch {
                        setMarkdown(
                          normalizeMathDelimiters(SAMPLE.trim()) + '\n',
                        )
                      }
                    } else {
                      setMarkdown(normalizeMathDelimiters(SAMPLE.trim()) + '\n')
                    }
                    setOcrStatus(
                      `Reset to sample paper (p.1–${m.pages.length})`,
                    )
                  })()
                }}
              >
                Reset sample
              </button>
              <button
                type="button"
                title="Clear editor before building page by page"
                onClick={() => setMarkdown('')}
              >
                Clear
              </button>
            </div>
            {cropImageSrc && samplePreviewOpen ? (
              <div className="sample-thumb-row sample-thumb-col">
                <div className="sample-thumb-meta">
                  <p className="sample-hint">
                    {usingSampleDoc && sampleManifest
                      ? `${sampleManifest.title} — p.${cropPage}`
                      : `Page ${cropPage}${activeDocSlug ? ` · ${activeDocSlug}` : ''}`}
                    {' — '}
                    open layout editor to fix boxes, then Re-run OCR.
                  </p>
                  <button
                    type="button"
                    className="sample-thumb-dismiss"
                    aria-label="Hide page preview"
                    title="Hide page preview"
                    onClick={() => setSamplePreviewOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="crop-thumb-wrap">
                  <img
                    className="crop-thumb-img"
                    src={cropImageSrc}
                    alt={`Page ${cropPage}`}
                  />
                </div>
              </div>
            ) : cropImageSrc ? (
              <button
                type="button"
                className="sample-thumb-show"
                onClick={() => setSamplePreviewOpen(true)}
              >
                Show page preview
              </button>
            ) : null}
          </div>
          <textarea
            ref={editorRef}
            className="editor"
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value)
              setEditorCursor(e.target.selectionStart)
            }}
            onSelect={(e) =>
              setEditorCursor((e.target as HTMLTextAreaElement).selectionStart)
            }
            onClick={(e) =>
              setEditorCursor((e.target as HTMLTextAreaElement).selectionStart)
            }
            onKeyUp={(e) =>
              setEditorCursor((e.target as HTMLTextAreaElement).selectionStart)
            }
            spellCheck={false}
            aria-label="Markdown editor"
          />
        </section>

        <section className="pane">
          <div className="pane-head">
            <h2>Preview</h2>
            <span className="meta">MathJax · GFM</span>
          </div>
          <div className="preview">{preview}</div>
        </section>
      </main>

      {/* Fixed overlays — outside .pane so overflow:hidden doesn't clip */}
      <EditorPartZoom
        markdown={markdown}
        cursor={editorCursor}
        hidden={cropModalOpen && !!cropImageSrc}
      />
      {/* Always mounted — never unmount when modal opens (that looked like "dismiss"). */}
      <div className="crop-dock-fab-wrap">
        <label className="crop-dock-page">
          <span className="visually-hidden">Layout page</span>
          <select
            value={cropPage}
            aria-label="Select page for layout editor"
            onChange={(e) => setCropPage(Number(e.target.value))}
          >
            {(cropPageOptions.length ? cropPageOptions : [cropPage || 1]).map(
              (n) => (
                <option key={n} value={n}>
                  p.{n}
                </option>
              ),
            )}
          </select>
        </label>
        <button
          type="button"
          className="crop-dock-fab"
          title={
            cropImageSrc
              ? `Edit layout · p.${cropPage}`
              : 'OCR / load a page image first'
          }
          aria-label={`Open layout editor page ${cropPage}`}
          disabled={!cropImageSrc}
          onClick={() => setCropModalOpen(true)}
        >
          Edit
          <br />
          layout
        </button>
      </div>
      {cropModalOpen && cropImageSrc ? (
        <div
          className="crop-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit layout page ${cropPage}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCropModalOpen(false)
          }}
        >
          <div className="crop-modal">
            <PageCropEditor
              key={
                detectSession
                  ? `detect:${detectSession.slug}:${detectSession.page}`
                  : `layout:${activeDocSlug || 'doc'}:${cropPage}`
              }
              markdown={markdown}
              page={detectSession?.page ?? cropPage}
              imageSrc={cropImageSrc}
              analysisSlug={detectSession?.slug ?? activeDocSlug}
              onMarkdownChange={setMarkdown}
              onSaveLayout={
                detectSession
                  ? undefined
                  : (regions) => void onSaveLayout(regions)
              }
              onRerunWithLayout={
                detectSession
                  ? undefined
                  : (regions, mfd) => void onRerunWithLayout(regions, mfd)
              }
              onTrainLayout={() => void onTrainLayout()}
              layoutBusy={layoutBusy}
              layoutTrainPairs={layoutTrainPairs}
              trainingSession={!!detectSession}
              imageSize={
                detectSession && detectSession.width > 1
                  ? { w: detectSession.width, h: detectSession.height }
                  : analysisCache[
                      `${detectSession?.slug ?? activeDocSlug}:${detectSession?.page ?? cropPage}`
                    ]?.width
                    ? {
                        w: analysisCache[
                          `${detectSession?.slug ?? activeDocSlug}:${detectSession?.page ?? cropPage}`
                        ]!.width!,
                        h: analysisCache[
                          `${detectSession?.slug ?? activeDocSlug}:${detectSession?.page ?? cropPage}`
                        ]!.height!,
                      }
                    : null
              }
              initialLayout={detectSession?.layout ?? null}
              initialMfd={detectSession?.mfd ?? null}
              onConfirmContinue={
                detectSession
                  ? (layout, mfd) => void onConfirmContinue(layout, mfd)
                  : undefined
              }
              fillViewport
              onClose={() => {
                setCropModalOpen(false)
                if (detectSession) {
                  setDetectSession(null)
                  setTrainingQueue(null)
                  setOcrStatus('Training edit cancelled')
                }
              }}
              onStatus={setOcrStatus}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
