import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { injectLatexIntoDocx } from './docxMathPreprocess'

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})

turndown.addRule('paragraphBreak', {
  filter: 'p',
  replacement(content) {
    const text = content.trim()
    return text ? `\n\n${text}\n\n` : '\n\n'
  },
})

// Word auto-numbers → Markdown ordered lists (explicit li prefix)
turndown.addRule('listItem', {
  filter: 'li',
  replacement(content, node) {
    const el = node as HTMLElement
    const parent = el.parentElement
    const ordered = parent?.nodeName === 'OL'
    const siblings = parent
      ? Array.from(parent.children).filter((c) => c.nodeName === 'LI')
      : []
    const index = siblings.indexOf(el) + 1
    const start = parent?.getAttribute('start')
    const n = start ? parseInt(start, 10) + index - 1 : index
    const prefix = ordered ? `${n}. ` : '- '
    const body = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/\n/gm, '\n    ')
    return `${prefix}${body.trim()}\n`
  },
})

function protectMath(html: string): { html: string; slots: string[] } {
  const slots: string[] = []
  const replaced = html.replace(
    /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g,
    (match) => {
      const i = slots.length
      slots.push(match)
      return `@@MATH${i}@@`
    },
  )
  return { html: replaced, slots }
}

function restoreMath(md: string, slots: string[]): string {
  return md.replace(/@@MATH(\d+)@@/g, (_, n) => slots[Number(n)] ?? '')
}

/** Turn Word <sup>/<sub> (and italic+sup patterns) into LaTeX. */
function convertWordScriptsToLatex(html: string): string {
  let out = html

  // <em>a</em><sup>m</sup> / <i>a</i><sub>1</sub> (common mammoth output)
  out = out.replace(
    /<(em|i|strong|b)>([^<]+)<\/\1>\s*<sup>([^<]+)<\/sup>/gi,
    (_m, _t, base: string, exp: string) =>
      `$${base.trim()}^{${exp.trim()}}$`,
  )
  out = out.replace(
    /<(em|i|strong|b)>([^<]+)<\/\1>\s*<sub>([^<]+)<\/sub>/gi,
    (_m, _t, base: string, sub: string) =>
      `$${base.trim()}_{${sub.trim()}}$`,
  )

  // <em>a<sup>m</sup></em>
  out = out.replace(
    /<(em|i|strong|b)>([^<]*)<sup>([^<]+)<\/sup>([^<]*)<\/\1>/gi,
    (_m, _t, before: string, exp: string, after: string) => {
      const base = (before + after).trim()
      return base ? `$${base}^{${exp.trim()}}$` : `$^{${exp.trim()}}$`
    },
  )
  out = out.replace(
    /<(em|i|strong|b)>([^<]*)<sub>([^<]+)<\/sub>([^<]*)<\/\1>/gi,
    (_m, _t, before: string, sub: string, after: string) => {
      const base = (before + after).trim()
      return base ? `$${base}_{${sub.trim()}}$` : `$_{${sub.trim()}}$`
    },
  )

  // a<sup>m</sup> (plain letter immediately before)
  out = out.replace(
    /([A-Za-z0-9πΠ])<sup>([^<]+)<\/sup>/g,
    (_m, base: string, exp: string) => `$${base}^{${exp.trim()}}$`,
  )
  out = out.replace(
    /([A-Za-z0-9πΠ])<sub>([^<]+)<\/sub>/g,
    (_m, base: string, sub: string) => `$${base}_{${sub.trim()}}$`,
  )

  // leftover bare <sup>/<sub>
  out = out.replace(/<sup>([^<]+)<\/sup>/gi, (_m, exp: string) => `$^{${exp.trim()}}$`)
  out = out.replace(/<sub>([^<]+)<\/sub>/gi, (_m, sub: string) => `$_{${sub.trim()}}$`)

  // Merge adjacent math: $a^{m}$$^{n}$ → $a^{m}^{n}$
  out = out.replace(/\$\s*\$/g, '')
  return out
}

function tidyMarkdown(md: string): string {
  return (
    md
      .replace(/\r\n/g, '\n')
      .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '')
      .replace(/%\s*MathType!MTEF![\s\S]*?![0-9A-Fa-f]{4}!\s*/g, '')
      .replace(/%\s*MathType[^\n]*\n/g, '')
      .replace(/\$\$\s*\n+/g, '$$\n')
      .replace(/\n+\s*\$\$/g, '\n$$')
      .replace(/^(?![*-]\s)([A-D]\.)(\s+)/gm, '- $1$2')
      .replace(/^(\d+)\\(\.)/gm, '$1$2')
      // Join $a^{m}$$+$$^{n}$ style leftovers
      .replace(/\$([^$]+)\$\s*\$([^$]+)\$/g, '$$$1$2$$')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  )
}

function slugify(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'import'
  )
}

function extForContentType(contentType: string): string {
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('gif')) return 'gif'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('svg')) return 'svg'
  return 'bin'
}

async function saveImagesToImports(
  slug: string,
  files: { name: string; base64: string }[],
): Promise<string[]> {
  if (files.length === 0) return []
  try {
    const res = await fetch('/api/import-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, files }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { ok: boolean; paths?: string[]; error?: string }
    if (!data.ok) throw new Error(data.error || 'save failed')
    return data.paths || []
  } catch {
    // Fallback: blob URLs (session-only)
    return files.map((f) => {
      const bin = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
      const blob = new Blob([bin])
      return URL.createObjectURL(blob)
    })
  }
}

export type WordImportResult = {
  markdown: string
  messages: string[]
  equationCount: number
  mathtypeCount: number
  imageCount: number
  imageDir?: string
}

/**
 * Convert a .docx file to Markdown.
 * - Images → public/imports/<slug>/ + ![…](/imports/…)
 * - Word superscript/subscript → LaTeX
 * - Word auto-numbering → Markdown ordered lists
 */
export async function wordFileToMarkdown(file: File): Promise<WordImportResult> {
  const original = await file.arrayBuffer()
  const { buffer, equationCount, mathtypeCount } = await injectLatexIntoDocx(original)

  const slug = slugify(file.name)
  const pendingImages: { name: string; base64: string }[] = []
  let imageIndex = 0

  const { value: html, messages } = await mammoth.convertToHtml(
    { arrayBuffer: buffer },
    {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
      ],
      convertImage: mammoth.images.imgElement(async (image) => {
        imageIndex += 1
        const ext = extForContentType(image.contentType)
        const name = `img-${String(imageIndex).padStart(3, '0')}.${ext}`
        const base64 = await image.readAsBase64String()
        pendingImages.push({ name, base64 })
        // Temporary path; rewritten after save
        return { src: `__IMG__${name}__` }
      }),
    },
  )

  const paths = await saveImagesToImports(slug, pendingImages)
  const pathByName = new Map(
    pendingImages.map((f, i) => [f.name, paths[i] || `/imports/${slug}/${f.name}`]),
  )

  let withImages = html.replace(/__IMG__([^_]+)__/g, (_m, name: string) => {
    return pathByName.get(name) || `/imports/${slug}/${name}`
  })

  withImages = convertWordScriptsToLatex(withImages)

  const { html: safeHtml, slots } = protectMath(withImages)
  let markdown = tidyMarkdown(restoreMath(turndown.turndown(safeHtml), slots))
  markdown = normalizeMathTypeLatex(markdown)

  const notes = messages.map((m) => m.message)
  if (pendingImages.length > 0) {
    notes.push(
      `${pendingImages.length} image(s) saved under /imports/${slug}/`,
    )
  }
  if (mathtypeCount > 0) {
    notes.push(
      `${mathtypeCount} MathType OLE still present — run Tools/mathtype_docx_to_latex.py first.`,
    )
  }

  return {
    markdown,
    messages: notes,
    equationCount,
    mathtypeCount,
    imageCount: pendingImages.length,
    imageDir: pendingImages.length > 0 ? `/imports/${slug}/` : undefined,
  }
}

function normalizeMathTypeLatex(md: string): string {
  return (
    md
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
      .replace(/\n{3,}/g, '\n\n')
  )
}
