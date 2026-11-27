import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Markdown from 'react-markdown'
import rehypeMathjax from 'rehype-mathjax'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import {
  appendContentItem,
  ContentPageError,
  createContentPage,
  editContentItem,
  getContentPage,
  openDraftVersion,
  publishContentPage,
  type AtomInput,
  type AtomKind,
  type ContentPageDocument,
  type ContentPageItem,
  type PageKind,
  type PaperInput,
  type QKind,
  type SourceType,
} from './contentPageClient'
import { prepareMarkdownForPreview } from './mathFormat'

const RECENT_KEY = 'alphaeqt.contentPages.recent'

const ATOM_KIND_OPTIONS: { value: AtomKind; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'title', label: 'Title' },
  { value: 'question', label: 'Question' },
  { value: 'figure', label: 'Figure' },
  { value: 'formula', label: 'Formula' },
  { value: 'topic', label: 'Topic' },
  { value: 'theorem', label: 'Theorem' },
]

const PAGE_KIND_OPTIONS: { value: PageKind; label: string }[] = [
  { value: 'note', label: 'Note' },
  { value: 'web', label: 'Web' },
  { value: 'app', label: 'App' },
]

const SOURCE_OPTIONS: { value: '' | SourceType; label: string }[] = [
  { value: '', label: 'Omit (paper default, or author)' },
  { value: 'A', label: 'A · author' },
  { value: 'S', label: 'S · school' },
  { value: 'P', label: 'P · publisher' },
]

const QKIND_OPTIONS: { value: QKind; label: string }[] = [
  { value: 'MC', label: 'MC · multiple choice' },
  { value: 'SQ', label: 'SQ · structured' },
  { value: 'LQ', label: 'LQ · long' },
]

type AtomDraft = {
  id: number
  kind: AtomKind
  title: string
  markdown: string
  qkind: QKind
  sourceType: '' | SourceType
  marks: string
  figureTitle: string
  figureMarkdown: string
}

type RecentPage = { slug: string; title: string }

type ScreenProps = {
  slug: string | null
  onOpenSlug: (slug: string) => void
  onShowCreate: () => void
}

let atomKey = 0

function blankAtom(kind: AtomKind = 'text'): AtomDraft {
  atomKey += 1
  return {
    id: atomKey,
    kind,
    title: '',
    markdown: '',
    qkind: 'MC',
    sourceType: '',
    marks: '',
    figureTitle: '',
    figureMarkdown: '',
  }
}

function readRecent(): RecentPage[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (row): row is RecentPage =>
        !!row &&
        typeof row === 'object' &&
        typeof (row as RecentPage).slug === 'string' &&
        typeof (row as RecentPage).title === 'string',
    )
  } catch {
    return []
  }
}

function rememberPage(slug: string, title: string) {
  const next = [
    { slug, title },
    ...readRecent().filter((row) => row.slug !== slug),
  ].slice(0, 12)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore private-mode storage failures */
  }
}

function errorOf(err: unknown): { message: string; code?: string } {
  if (err instanceof ContentPageError) {
    return { message: err.message, code: err.code }
  }
  if (err instanceof Error && err.message) return { message: err.message }
  return { message: 'Request failed.' }
}

function statusLabel(status: string | null | undefined): string {
  if (status === 'D') return 'Draft'
  if (status === 'A') return 'Published'
  return status || 'Unknown'
}

function kindLabel(kind: string | null | undefined): string {
  const match = ATOM_KIND_OPTIONS.find((option) => option.value === kind)
  if (match) return match.label
  if (kind === 'question') return 'Question'
  return kind || 'Atom'
}

function isDraft(doc: ContentPageDocument): boolean {
  return doc.version?.status === 'D'
}

function toAtomInput(draft: AtomDraft): AtomInput {
  const marksText = draft.marks.trim()
  let marks: number | null = null
  if (marksText) {
    if (!/^\d+$/.test(marksText) || Number(marksText) > 10000) {
      throw new ContentPageError(
        400,
        'bad_item',
        'Marks must be a whole number from 0 to 10000.',
      )
    }
    marks = Number(marksText)
  }
  return {
    kind: draft.kind,
    title: draft.title,
    markdown: draft.markdown,
    qkind: draft.qkind,
    sourceType: draft.sourceType,
    marks,
    figure:
      draft.kind === 'question' && draft.figureMarkdown.trim()
        ? { title: draft.figureTitle, markdown: draft.figureMarkdown }
        : null,
  }
}

function paperFromFields(
  slug: string,
  title: string,
  sourceType: '' | SourceType,
): PaperInput | null {
  if (!slug.trim() && !title.trim() && !sourceType) return null
  return { slug, title, sourceType }
}

function MarkdownView({ markdown }: { markdown: string }) {
  const body = useMemo(() => prepareMarkdownForPreview(markdown), [markdown])
  if (!markdown.trim()) return null
  return (
    <div className="preview page-atom-preview">
      <Markdown
        remarkPlugins={[
          remarkGfm,
          remarkBreaks,
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
      >
        {body}
      </Markdown>
    </div>
  )
}

function RecentPages({
  onOpenSlug,
}: {
  onOpenSlug: (slug: string) => void
}) {
  const [recent, setRecent] = useState<RecentPage[]>(() => readRecent())
  useEffect(() => {
    const refresh = () => setRecent(readRecent())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  if (recent.length === 0) return null
  return (
    <div className="page-recent">
      <span>Recent</span>
      {recent.map((row) => (
        <button
          key={row.slug}
          type="button"
          className="page-btn secondary"
          onClick={() => onOpenSlug(row.slug)}
        >
          {row.title || row.slug}
        </button>
      ))}
    </div>
  )
}

function OpenPageForm({
  onOpenSlug,
}: {
  onOpenSlug: (slug: string) => void
}) {
  const [slug, setSlug] = useState('')
  return (
    <form
      className="page-open"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const next = slug.trim()
        if (!next) return
        onOpenSlug(next)
      }}
    >
      <label className="import-field">
        <span>Open by slug</span>
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="s6-alg-notes"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
        />
      </label>
      <button type="submit" className="page-btn secondary" disabled={!slug.trim()}>
        Open
      </button>
    </form>
  )
}

function AtomFields({
  draft,
  idPrefix,
  onChange,
}: {
  draft: AtomDraft
  idPrefix: string
  onChange: (patch: Partial<AtomDraft>) => void
}) {
  const question = draft.kind === 'question'
  return (
    <div className="page-grid">
      <label className="import-field" htmlFor={`${idPrefix}-kind`}>
        <span>Kind</span>
        <select
          id={`${idPrefix}-kind`}
          value={draft.kind}
          onChange={(event) =>
            onChange({ kind: event.target.value as AtomKind })
          }
        >
          {ATOM_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="import-field" htmlFor={`${idPrefix}-title`}>
        <span>{question ? 'Title (question number)' : 'Title (optional)'}</span>
        <input
          id={`${idPrefix}-title`}
          value={draft.title}
          maxLength={255}
          placeholder={question ? 'Q13' : 'Section A'}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      {question ? (
        <>
          <label className="import-field" htmlFor={`${idPrefix}-qkind`}>
            <span>Question kind</span>
            <select
              id={`${idPrefix}-qkind`}
              value={draft.qkind}
              onChange={(event) =>
                onChange({ qkind: event.target.value as QKind })
              }
            >
              {QKIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="import-field" htmlFor={`${idPrefix}-source`}>
            <span>Source type</span>
            <select
              id={`${idPrefix}-source`}
              value={draft.sourceType}
              onChange={(event) =>
                onChange({
                  sourceType: event.target.value as '' | SourceType,
                })
              }
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value || 'omit'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="import-field" htmlFor={`${idPrefix}-marks`}>
            <span>Marks (optional)</span>
            <input
              id={`${idPrefix}-marks`}
              value={draft.marks}
              inputMode="numeric"
              placeholder="3"
              onChange={(event) => onChange({ marks: event.target.value })}
            />
          </label>
        </>
      ) : null}
      <label
        className="import-field page-field page-field-wide"
        htmlFor={`${idPrefix}-markdown`}
      >
        <span>{question ? 'Stem markdown' : 'Markdown'}</span>
        <textarea
          id={`${idPrefix}-markdown`}
          value={draft.markdown}
          spellCheck={false}
          placeholder={
            question
              ? '13. Which is larger?\n\n- A. \\(2\\)\n- B. \\(3\\)'
              : 'Answer all questions.'
          }
          onChange={(event) => onChange({ markdown: event.target.value })}
        />
      </label>
      {question ? (
        <div className="page-field-wide">
          <p className="page-help">
            Leave source type on Omit to use the paper default, or author (A)
            when this import has no paper. The question number stays in the
            title and the stem. A figure is stored as the next atom.
          </p>
          <details className="page-details">
            <summary>Figure (optional, next atom)</summary>
            <div className="page-grid">
              <label className="import-field" htmlFor={`${idPrefix}-fig-title`}>
                <span>Figure title</span>
                <input
                  id={`${idPrefix}-fig-title`}
                  value={draft.figureTitle}
                  maxLength={255}
                  placeholder="fig13"
                  onChange={(event) =>
                    onChange({ figureTitle: event.target.value })
                  }
                />
              </label>
              <label
                className="import-field page-field page-field-wide"
                htmlFor={`${idPrefix}-fig-md`}
              >
                <span>Figure markdown</span>
                <textarea
                  id={`${idPrefix}-fig-md`}
                  value={draft.figureMarkdown}
                  spellCheck={false}
                  placeholder="![figure-right](/imports/s6-alg-notes/fig13.svg)"
                  onChange={(event) =>
                    onChange({ figureMarkdown: event.target.value })
                  }
                />
              </label>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  )
}

function PaperFields({
  slug,
  title,
  sourceType,
  onSlug,
  onTitle,
  onSource,
}: {
  slug: string
  title: string
  sourceType: '' | SourceType
  onSlug: (value: string) => void
  onTitle: (value: string) => void
  onSource: (value: '' | SourceType) => void
}) {
  return (
    <details className="page-details">
      <summary>Paper (optional)</summary>
      <p className="page-help">
        Questions that omit their own source type use this paper. Leave it
        blank and the API keeps paper_id null, then uses author (A).
      </p>
      <div className="page-grid">
        <label className="import-field">
          <span>Paper slug</span>
          <input
            value={slug}
            maxLength={64}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="s6-alg-2024"
            onChange={(event) => onSlug(event.target.value)}
          />
        </label>
        <label className="import-field">
          <span>Paper title</span>
          <input
            value={title}
            maxLength={255}
            placeholder="S6 algebra 2024"
            onChange={(event) => onTitle(event.target.value)}
          />
        </label>
        <label className="import-field">
          <span>Paper source type</span>
          <select
            value={sourceType}
            onChange={(event) =>
              onSource(event.target.value as '' | SourceType)
            }
          >
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.value || 'omit'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  )
}

function CreatePageForm({
  onOpenSlug,
}: {
  onOpenSlug: (slug: string) => void
}) {
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<PageKind>('note')
  const [paperSlug, setPaperSlug] = useState('')
  const [paperTitle, setPaperTitle] = useState('')
  const [paperSource, setPaperSource] = useState<'' | SourceType>('')
  const [atoms, setAtoms] = useState<AtomDraft[]>(() => [blankAtom()])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ message: string; code?: string } | null>(
    null,
  )

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      const doc = await createContentPage({
        slug,
        title,
        kind,
        paper: paperFromFields(paperSlug, paperTitle, paperSource),
        items: atoms.map(toAtomInput),
      })
      rememberPage(doc.page.slug, doc.page.title)
      onOpenSlug(doc.page.slug)
    } catch (err) {
      setError(errorOf(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="page-screen">
      <section className="page-card">
        <h2>New draft</h2>
        <p className="page-help">
          Slug is the URL name. Kind is note, web, or app. The page stays a
          draft until you publish it. Import stores at least one atom with
          the page; append more after it exists.
        </p>
        <form
          className="page-form"
          autoComplete="off"
          noValidate
          onSubmit={(event) => void onCreate(event)}
        >
          <div className="page-grid">
            <label className="import-field" htmlFor="create-slug">
              <span>Slug</span>
              <input
                id="create-slug"
                value={slug}
                autoFocus
                required
                maxLength={64}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="s6-alg-notes"
                onChange={(event) => setSlug(event.target.value)}
              />
            </label>
            <label className="import-field" htmlFor="create-title">
              <span>Title</span>
              <input
                id="create-title"
                value={title}
                required
                maxLength={255}
                placeholder="S6 algebra notes"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="import-field" htmlFor="create-kind">
              <span>Kind</span>
              <select
                id="create-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as PageKind)}
              >
                {PAGE_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <PaperFields
            slug={paperSlug}
            title={paperTitle}
            sourceType={paperSource}
            onSlug={setPaperSlug}
            onTitle={setPaperTitle}
            onSource={setPaperSource}
          />
          <div className="page-atoms">
            {atoms.map((atom, index) => (
              <fieldset key={atom.id} className="page-atom-fields">
                <legend>Initial atom {index + 1}</legend>
                <AtomFields
                  draft={atom}
                  idPrefix={`create-${atom.id}`}
                  onChange={(patch) =>
                    setAtoms((rows) =>
                      rows.map((row) =>
                        row.id === atom.id ? { ...row, ...patch } : row,
                      ),
                    )
                  }
                />
                <div className="page-actions">
                  <button
                    type="button"
                    className="page-btn secondary"
                    disabled={atoms.length === 1}
                    title={
                      atoms.length === 1
                        ? 'Import needs at least one atom'
                        : 'Remove this atom'
                    }
                    onClick={() =>
                      setAtoms((rows) =>
                        rows.length === 1
                          ? rows
                          : rows.filter((row) => row.id !== atom.id),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              </fieldset>
            ))}
          </div>
          {error ? (
            <div className="page-error" role="alert">
              <p>{error.message}</p>
              {error.code === 'page_exists' ? (
                <button
                  type="button"
                  className="page-btn secondary"
                  onClick={() => onOpenSlug(slug.trim())}
                >
                  Open {slug.trim()}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="page-actions">
            <button type="submit" className="page-btn" disabled={pending}>
              {pending ? 'Creating…' : 'Create draft'}
            </button>
            <button
              type="button"
              className="page-btn secondary"
              disabled={pending}
              onClick={() => setAtoms((rows) => [...rows, blankAtom()])}
            >
              Add atom
            </button>
          </div>
        </form>
      </section>
      <section className="page-card">
        <h2>Open a page</h2>
        <OpenPageForm onOpenSlug={onOpenSlug} />
        <RecentPages onOpenSlug={onOpenSlug} />
      </section>
    </div>
  )
}

function PageDraft({
  slug,
  onOpenSlug,
  onShowCreate,
}: {
  slug: string
  onOpenSlug: (slug: string) => void
  onShowCreate: () => void
}) {
  const [doc, setDoc] = useState<ContentPageDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<'load' | 'append' | 'edit' | 'publish' | 'version' | null>(
    'load',
  )
  const [edit, setEdit] = useState<{
    sortorder: number
    title: string
    markdown: string
  } | null>(null)
  const [append, setAppend] = useState<AtomDraft>(() => blankAtom())
  const [paperSlug, setPaperSlug] = useState('')
  const [paperTitle, setPaperTitle] = useState('')
  const [paperSource, setPaperSource] = useState<'' | SourceType>('')

  useEffect(() => {
    let cancel = false
    setPending('load')
    setError(null)
    setNotice(null)
    setDoc(null)
    setEdit(null)
    getContentPage(slug)
      .then((view) => {
        if (cancel) return
        setDoc(view)
        rememberPage(view.page.slug, view.page.title)
      })
      .catch((err) => {
        if (cancel) return
        setError(errorOf(err).message)
      })
      .finally(() => {
        if (!cancel) setPending((current) => (current === 'load' ? null : current))
      })
    return () => {
      cancel = true
    }
  }, [slug])

  const draft = doc ? isDraft(doc) : false

  async function onAppend(event: FormEvent) {
    event.preventDefault()
    if (!doc) return
    setError(null)
    setNotice(null)
    setPending('append')
    try {
      const view = await appendContentItem(
        doc.page.slug,
        toAtomInput(append),
        paperFromFields(paperSlug, paperTitle, paperSource),
      )
      setDoc(view)
      setAppend(blankAtom())
      setNotice('Atom appended.')
    } catch (err) {
      setError(errorOf(err).message)
    } finally {
      setPending(null)
    }
  }

  async function onSaveEdit(event: FormEvent) {
    event.preventDefault()
    if (!doc || !edit) return
    setError(null)
    setNotice(null)
    setPending('edit')
    try {
      const view = await editContentItem(
        doc.page.slug,
        edit.sortorder,
        edit.markdown,
        edit.title,
      )
      setDoc(view)
      setEdit(null)
      setNotice('Draft revision saved. The pin now points at the new revision.')
    } catch (err) {
      setError(errorOf(err).message)
    } finally {
      setPending(null)
    }
  }

  async function onPublish() {
    if (!doc) return
    const ok = window.confirm(
      'Publish this version? Published versions keep their pinned revisions and stay read-only.',
    )
    if (!ok) return
    setError(null)
    setNotice(null)
    setPending('publish')
    try {
      const view = await publishContentPage(doc.page.slug)
      setDoc(view)
      setEdit(null)
      setNotice('Published. This version is now immutable.')
    } catch (err) {
      setError(errorOf(err).message)
    } finally {
      setPending(null)
    }
  }

  async function onNewDraft() {
    if (!doc) return
    const ok = window.confirm(
      'Open the next draft? The published version stays pinned. The new draft clones those atoms.',
    )
    if (!ok) return
    setError(null)
    setNotice(null)
    setPending('version')
    try {
      const view = await openDraftVersion(doc.page.slug)
      setDoc(view)
      setNotice('New draft opened from the published pins.')
    } catch (err) {
      setError(errorOf(err).message)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="page-screen">
      <section className="page-card">
        <div className="page-card-head">
          <div>
            <h2>{doc?.page.title || slug}</h2>
            <p className="page-meta">
              <code>{doc?.page.slug || slug}</code>
              {doc ? (
                <>
                  <span className={`page-badge ${doc.page.status === 'D' ? 'is-draft' : 'is-published'}`}>
                    Page {statusLabel(doc.page.status)}
                  </span>
                  <span
                    className={`page-badge ${draft ? 'is-draft' : 'is-published'}`}
                  >
                    Version {doc.version?.version_no ?? '—'}{' '}
                    {statusLabel(doc.version?.status)}
                  </span>
                  <span>{doc.items.length} atoms</span>
                  {doc.paper_id != null ? <span>paper {doc.paper_id}</span> : null}
                </>
              ) : null}
            </p>
          </div>
          <div className="page-actions">
            <button type="button" className="page-btn secondary" onClick={onShowCreate}>
              Create another
            </button>
            {doc && draft ? (
              <button
                type="button"
                className="page-btn"
                disabled={pending !== null}
                onClick={() => void onPublish()}
              >
                {pending === 'publish' ? 'Publishing…' : 'Publish draft'}
              </button>
            ) : null}
            {doc && !draft ? (
              <button
                type="button"
                className="page-btn"
                disabled={pending !== null}
                onClick={() => void onNewDraft()}
              >
                {pending === 'version' ? 'Opening…' : 'New draft version'}
              </button>
            ) : null}
          </div>
        </div>
        {pending === 'load' && !doc ? <p className="page-help">Loading page…</p> : null}
        {error ? (
          <p className="page-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="page-notice" role="status">
            {notice}
          </p>
        ) : null}
        {doc && !draft ? (
          <p className="page-help">
            This version is published, so its revision pins stay put. Open a
            new draft to append or edit.
          </p>
        ) : null}
        {doc ? (
          <ol className="page-item-list">
            {doc.items.map((item) => (
              <PageItem
                key={`${item.sortorder}-${item.revision_id}`}
                item={item}
                draft={draft}
                pending={pending !== null}
                editing={edit?.sortorder === item.sortorder ? edit : null}
                onEdit={() =>
                  setEdit({
                    sortorder: item.sortorder,
                    title: item.title ?? '',
                    markdown: item.markdown,
                  })
                }
                onCancel={() => setEdit(null)}
                onChange={(patch) =>
                  setEdit((current) =>
                    current && current.sortorder === item.sortorder
                      ? { ...current, ...patch }
                      : current,
                  )
                }
                onSave={(event) => void onSaveEdit(event)}
              />
            ))}
          </ol>
        ) : null}
      </section>

      {doc && draft ? (
        <section className="page-card">
          <h2>Append an atom</h2>
          <p className="page-help">
            One atom at a time. A question is sent as kind question, which
            creates a questions row and a question stem. Ordinary atoms do
            not send source type.
          </p>
          <form noValidate onSubmit={(event) => void onAppend(event)}>
            <AtomFields
              draft={append}
              idPrefix="append"
              onChange={(patch) => setAppend((current) => ({ ...current, ...patch }))}
            />
            {append.kind === 'question' ? (
              <PaperFields
                slug={paperSlug}
                title={paperTitle}
                sourceType={paperSource}
                onSlug={setPaperSlug}
                onTitle={setPaperTitle}
                onSource={setPaperSource}
              />
            ) : null}
            <div className="page-actions">
              <button type="submit" className="page-btn" disabled={pending !== null}>
                {pending === 'append' ? 'Appending…' : 'Append atom'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="page-card">
        <h2>Open another</h2>
        <OpenPageForm onOpenSlug={onOpenSlug} />
        <RecentPages onOpenSlug={onOpenSlug} />
      </section>
    </div>
  )
}

function PageItem({
  item,
  draft,
  pending,
  editing,
  onEdit,
  onCancel,
  onChange,
  onSave,
}: {
  item: ContentPageItem
  draft: boolean
  pending: boolean
  editing: { sortorder: number; title: string; markdown: string } | null
  onEdit: () => void
  onCancel: () => void
  onChange: (patch: { title?: string; markdown?: string }) => void
  onSave: (event: FormEvent) => void
}) {
  return (
    <li className="page-item">
      <div className="page-item-head">
        <p className="page-meta">
          <span className="page-badge">{kindLabel(item.kind)}</span>
          <span>#{item.sortorder}</span>
          {item.title ? <span>{item.title}</span> : null}
          {item.question_id != null ? (
            <span>questions row {item.question_id}</span>
          ) : null}
          <span>revision {item.revision_no}</span>
        </p>
        {draft && !editing ? (
          <button
            type="button"
            className="page-btn secondary"
            disabled={pending}
            onClick={onEdit}
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <form noValidate onSubmit={onSave}>
          <p className="page-help">
            A draft edit writes a new revision and retargets this atom. Kind
            and question source stay as they are.
          </p>
          <div className="page-grid">
            <label className="import-field page-field page-field-wide">
              <span>Title</span>
              <input
                value={editing.title}
                maxLength={255}
                onChange={(event) => onChange({ title: event.target.value })}
              />
            </label>
            <label className="import-field page-field page-field-wide">
              <span>Markdown</span>
              <textarea
                value={editing.markdown}
                spellCheck={false}
                onChange={(event) => onChange({ markdown: event.target.value })}
              />
            </label>
          </div>
          <MarkdownView markdown={editing.markdown} />
          <div className="page-actions">
            <button type="submit" className="page-btn" disabled={pending}>
              {pending ? 'Saving…' : 'Save revision'}
            </button>
            <button
              type="button"
              className="page-btn secondary"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <MarkdownView markdown={item.markdown} />
      )}
    </li>
  )
}

export default function ContentPages({
  slug,
  onOpenSlug,
  onShowCreate,
}: ScreenProps) {
  if (!slug) return <CreatePageForm onOpenSlug={onOpenSlug} />
  return (
    <PageDraft
      key={slug}
      slug={slug}
      onOpenSlug={onOpenSlug}
      onShowCreate={onShowCreate}
    />
  )
}
