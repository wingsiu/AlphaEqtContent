/**
 * Source markdown uses \( ... \) for inline math and $$ ... $$ for display.
 * Currency stays as \$36. Preview disables single-`$` inline math (`$abd$`)
 * so `$36 … $6` cannot pair; remark-math uses `$$…$$` for inline only.
 */

/** Repair form-feed corruption: \f + rac → \\frac (shows as □rac). */
export function repairTexEscapes(s: string): string {
  return s.replace(/\u000c+rac/g, '\\frac')
}

/** Strip outer math fences from a latex body. */
export function cleanLatex(raw: string): string {
  let s = repairTexEscapes(raw.trim())
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1)
  }
  s = s.replace(/\\"/g, '"').trim()
  // Flatten partial nests: 0.\(0023456789=\) → 0.0023456789= (P3 Q4)
  for (let i = 0; i < 4; i++) {
    const prev = s
    s = s.replace(/\\\(([\s\S]*?)\\\)/g, '$1')
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    s = s.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, '$1')
    if (s === prev) break
  }
  if (s.startsWith('$$') && s.endsWith('$$')) s = s.slice(2, -2).trim()
  else if (s.startsWith('\\(') && s.endsWith('\\)')) s = s.slice(2, -2).trim()
  else if (s.startsWith('$') && s.endsWith('$') && !s.startsWith('$$')) {
    s = s.slice(1, -1).trim()
  }
  return s
}

export function wrapInlineMath(latex: string): string {
  return `\\(${cleanLatex(latex)}\\)`
}

export function wrapDisplayMath(latex: string): string {
  return `\n$$\n${cleanLatex(latex)}\n$$\n`
}

export function toMarkdownMath(latex: string): string {
  const body = cleanLatex(latex)
  if (
    body.includes('\\begin') ||
    (body.includes('\\\\') && body.length > 40) ||
    body.length > 80
  ) {
    return wrapDisplayMath(body)
  }
  return wrapInlineMath(body)
}

/** Bare / coded currency → \$36 (source of truth; preview shows plain $). */
export function escapeCurrencyDollars(md: string): string {
  let s = md
  s = s.replace(/`\\\$(\d[\d,]*(?:\.\d+)?)`/g, (_m, d: string) => `\\$${d}`)
  s = s.replace(/`\$(\d[\d,]*(?:\.\d+)?)`/g, (_m, d: string) => `\\$${d}`)
  s = s.replace(/\\\$(\d[\d,]*(?:\.\d+)?)/g, (_m, d: string) => `\\$${d}`)
  s = s.replace(/(?<![`\\])\$(\d[\d,]*(?:\.\d+)?)/g, (_m, d: string) => `\\$${d}`)
  return s
}

/**
 * Normalize math delimiters for editor source.
 * - Currency → \$36
 * - Legacy $…$ pairs → \(…\)
 * - Keep $$ display blocks
 */
export function normalizeMathDelimiters(md: string): string {
  let s = repairTexEscapes(md)
  s = escapeCurrencyDollars(s)

  const displays: string[] = []
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => {
    const i = displays.length
    displays.push(`$$\n${body.trim()}\n$$`)
    return `\u0000D${i}\u0000`
  })
  // Hold \$ so it cannot start a $…$ pair
  s = s.replace(/\\\$/g, '\uE000')
  s = s.replace(/(?<!\\)\$([^\$\n]+?)(?<!\\)\$/g, (_, body: string) => `\\(${body}\\)`)
  s = s.replace(/\uE000/g, '\\$')
  s = s.replace(/\u0000D(\d+)\u0000/g, (_, i: string) => displays[Number(i)]!)
  // Collapse nested inline math: \(0.\(0023456789=\)\) → \(0.0023456789=\)
  for (let i = 0; i < 6; i++) {
    const next = s.replace(
      /\\\(((?:[^\\]|\\(?![()]))*)\\\(((?:[^\\]|\\(?![()]))*)\\\)((?:[^\\]|\\(?![()]))*)\\\)/g,
      (_m, a: string, b: string, c: string) => `\\(${a}${b}${c}\\)`,
    )
    if (next === s) break
    s = next
  }
  return stripFormulaPartMarkers(s)
}

/** Drop formula @part markers (overlays must not appear on the page image). */
export function stripFormulaPartMarkers(md: string): string {
  return md
    .replace(/\n*<!--\s*@part\s+kind=formula\b[^>]*-->\n*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

function isRunawayMath(body: string, maxLen: number): boolean {
  if (body.length > maxLen) return true
  if ((body.match(/\\ln/g) || []).length > 2) return true
  if ((body.match(/\\operatorname/g) || []).length > 2) return true
  if ((body.match(/displaystyle/g) || []).length > 2) return true
  if ((body.match(/\{/g) || []).length > 40) return true
  return false
}

/**
 * Preview cleanup. Source keeps \( … \) and \$36.
 *
 * remark-math with ``singleDollarTextMath: false``: bare `$abd$` is plain text.
 * Inline math is same-line ``$$…$$`` (not display ``$$\n…\n$$``). Convert
 * ``\(…\)`` → ``$$…$$`` for parsing; never leave single-`$` delimiters.
 * Currency held aside then restored as plain `$` (safe without single-dollar math).
 *
 * Hold existing math **before** any inequality/signed wraps — otherwise
 * ``\(18+7x>4\)`` becomes ``$18+\(7x>4$\)`` (p3 Q6). GFM also treats ``<``
 * as HTML, so convert ``<``/``>`` inside math to ``\lt``/``\gt``.
 */
export function prepareMarkdownForPreview(md: string): string {
  let s = repairTexEscapes(md)
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  s = s.replace(/\*?Source[^*\n]*\*?\s*\n+/gi, '')
  s = s.replace(/!\[[^\]]*source[^\]]*\]\([^)]+\)\s*/gi, '')

  // Protect currency before any $ / $$ work
  s = s.replace(/\\\$/g, '\uE000')
  s = s.replace(/(?<![\\\w])\$(\d[\d,]*(?:\.\d+)?)/g, '\uE000$1')

  // "8. …" / "10. …" must be paragraphs, not <ol> — else q-stem hang (0cm/1cm) never runs
  // and browser <ol> padding looks like a 2cm body indent (Q9/Q10).
  s = s.replace(/^( {0,3})(\d{1,3})\.(\s+\S)/gm, '$1$2\\.$3')

  // Live OCR nests options under @part ("   - A.") — flatten for preview tabs
  s = s.replace(/^( +)(- [A-D]\.)/gm, '$2')

  // Hold existing math so inequality repairs cannot nest inside \(…\)
  const heldMath: string[] = []
  const holdMath = (full: string): string => {
    const i = heldMath.length
    heldMath.push(full)
    return `\u0000M${i}\u0000`
  }
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (full) => holdMath(full))
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (full) => holdMath(full))

  // "- A. -5." → nested list eats the minus; wrap signed option values
  s = s.replace(
    /^(- [A-D]\. )([+\-−]\d+(?:\.\d+)?)(\.)?\s*$/gm,
    (_m, pre: string, num: string, dot: string | undefined) =>
      `${pre}\\(${num.replace(/−/g, '-')}\\)${dot || ''}`,
  )

  // p3 Q6: wrap bare inequalities left beside MFD math (hold already above).
  // Covers ``x>-2``, ``-2<x<1``, and algebraic ``18+7x>4`` / ``5-2x<3``.
  // Bare ``<`` otherwise becomes HTML and the remnant "doesn't render as math".
  const ineqSide =
    '(?:-?\\d+(?:\\.\\d+)?(?:\\s*[+\\-]\\s*\\d*[a-zA-Z])*|\\d*[a-zA-Z](?:\\s*[+\\-]\\s*(?:-?\\d+(?:\\.\\d+)?|\\d*[a-zA-Z]))*)'
  const ineqOp = '(?:<=|>=|≤|≥|<|>)'
  s = s.replace(
    new RegExp(
      `(?<![\\w\\\\])(${ineqSide}(?:\\s*${ineqOp}\\s*${ineqSide})+)(?![\\w])`,
      'gi',
    ),
    (_m, expr: string) => `\\(${expr.replace(/\s+/g, '')}\\)`,
  )

  // Restore held math, then convert \(…\) → $…$ with GFM-safe inequalities
  s = s.replace(/\u0000M(\d+)\u0000/g, (_, i: string) => heldMath[Number(i)]!)
  // Collapse accidental double-open: \(\(…\) → \(…\)
  s = s.replace(/\\\(\s*\\\(/g, '\\(')
  s = s.replace(/\\\)\s*\\\)/g, '\\)')

  // Bare I./II./III. blocks (blank lines ok) → ``- I.\t`` list like A–D
  s = s.replace(
    /(?:^|\n)((?:(?:IV|III|II|I)\.\s+[^\n]+(?:\n+|$)){2,})/g,
    (block) => {
      const lines = block
        .trim()
        .split('\n')
        .map((ln) => ln.trim())
        .filter(Boolean)
      if (!lines.every((ln) => /^(?:IV|III|II|I)\.\s+/.test(ln))) return block
      return (
        '\n\n' +
        lines
          .map((ln) => `- ${ln.replace(/^(I{1,3}|IV)\.\s+/, '$1.\t')}`)
          .join('\n') +
        '\n\n'
      )
    },
  )

  // Already-listed roman: normalize spaces after label to tab
  s = s.replace(
    /^(- (?:IV|III|II|I)\.)[ \t]+/gm,
    '$1\t',
  )

  s = s.replace(
    /((?:^|\n)(?:- (?:IV|III|II|I)\.\t?.+(?:\n+|$))+?)(?:\n*)(?=- [A-D]\.)/gm,
    '$1\n\n\u200b\n\n',
  )

  s = s.replace(
    /(?<!\*)\*([A-Za-z][A-Za-z0-9]{0,2})\*(?!\*)/g,
    (_m, body: string) => `\\(${body}\\)`,
  )
  s = s.replace(
    /(?<![A-Za-z0-9_])_([A-Za-z][A-Za-z0-9]{0,2})_(?![A-Za-z0-9_])/g,
    (_m, body: string) => `\\(${body}\\)`,
  )

  const displays: string[] = []
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => {
    if (isRunawayMath(body, 600)) return ''
    const i = displays.length
    displays.push(`$$${body}$$`)
    return `\u0000D${i}\u0000`
  })

  const gfmSafeMathBody = (body: string): string =>
    body
      .replace(/(?<!\\)</g, '\\lt ')
      .replace(/(?<!\\)>/g, '\\gt ')

  // \(…\) → same-line $$…$$ for remark-math inline (single-$ disabled).
  // Display blocks were held above as $$\n…\n$$ — do not use bare $…$.
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_full, body: string) => {
    if (isRunawayMath(body, 350)) return ''
    return `$$${gfmSafeMathBody(body)}$$`
  })

  s = s.replace(/\u0000D(\d+)\u0000/g, (_, i: string) => displays[Number(i)]!)
  // Currency: plain $ is safe now (single-dollar inline math is off)
  s = s.replace(/\uE000/g, '$')
  return s.replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
