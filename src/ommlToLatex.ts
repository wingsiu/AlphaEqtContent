/**
 * Convert Office Math (OMML) XML to LaTeX.
 * Covers the constructs common in school exam Word files.
 */

import { DOMParser as XmldomParser } from '@xmldom/xmldom'

const NS = {
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
}

const UNICODE_TO_LATEX: Record<string, string> = {
  'α': '\\alpha',
  'β': '\\beta',
  'γ': '\\gamma',
  'δ': '\\delta',
  'ε': '\\varepsilon',
  'ζ': '\\zeta',
  'η': '\\eta',
  'θ': '\\theta',
  'ι': '\\iota',
  'κ': '\\kappa',
  'λ': '\\lambda',
  'μ': '\\mu',
  'ν': '\\nu',
  'ξ': '\\xi',
  'π': '\\pi',
  'ρ': '\\rho',
  'σ': '\\sigma',
  'τ': '\\tau',
  'υ': '\\upsilon',
  'φ': '\\varphi',
  'χ': '\\chi',
  'ψ': '\\psi',
  'ω': '\\omega',
  'Α': 'A',
  'Β': 'B',
  'Γ': '\\Gamma',
  'Δ': '\\Delta',
  'Θ': '\\Theta',
  'Λ': '\\Lambda',
  'Ξ': '\\Xi',
  'Π': '\\Pi',
  'Σ': '\\Sigma',
  'Φ': '\\Phi',
  'Ψ': '\\Psi',
  'Ω': '\\Omega',
  '∞': '\\infty',
  '±': '\\pm',
  '∓': '\\mp',
  '≤': '\\leq',
  '≥': '\\geq',
  '≠': '\\neq',
  '≈': '\\approx',
  '≡': '\\equiv',
  '∈': '\\in',
  '∉': '\\notin',
  '∪': '\\cup',
  '∩': '\\cap',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '√': '\\sqrt',
  '→': '\\rightarrow',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow',
  '⋅': '\\cdot',
  '×': '\\times',
  '÷': '\\div',
  '°': '^\\circ',
  '′': "'",
  '″': "''",
  '…': '\\ldots',
  '−': '-',
  '–': '-',
  '—': '-',
}

const KNOWN_FUNCS = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'log',
  'ln',
  'lg',
  'exp',
  'lim',
  'max',
  'min',
  'sup',
  'inf',
  'det',
  'gcd',
  'lcm',
  'Pr',
])

function localName(el: Element): string {
  return el.localName || el.nodeName.replace(/^.*:/, '')
}

function elementChildren(el: Element): Element[] {
  const list = el.children
    ? Array.from(el.children)
    : Array.from(el.childNodes ?? []).filter(
        (n): n is Element => n.nodeType === 1,
      )
  return list as Element[]
}

function children(el: Element, name: string): Element[] {
  return elementChildren(el).filter((c) => localName(c) === name)
}

function firstChild(el: Element, name: string): Element | null {
  return children(el, name)[0] ?? null
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\u00a0/g, ' ')
}

function escapeLatexText(s: string): string {
  let out = ''
  for (const ch of s) {
    if (UNICODE_TO_LATEX[ch]) {
      out += UNICODE_TO_LATEX[ch] + ' '
    } else if (ch === '\\') {
      out += '\\backslash '
    } else if (ch === '{' || ch === '}' || ch === '#' || ch === '%' || ch === '&') {
      out += '\\' + ch
    } else if (ch === '~') {
      out += '\\sim '
    } else {
      out += ch
    }
  }
  return out
}

function convertChildren(el: Element): string {
  return elementChildren(el)
    .map((c) => convertNode(c))
    .join('')
}

function convertNode(el: Element): string {
  const name = localName(el)

  switch (name) {
    case 'oMath':
    case 'oMathPara':
    case 'e':
    case 'num':
    case 'den':
    case 'sub':
    case 'sup':
    case 'deg':
    case 'fName':
      return convertChildren(el)

    case 'r': {
      const t = firstChild(el, 't')
      return t ? escapeLatexText(textOf(t)) : convertChildren(el)
    }

    case 't':
      return escapeLatexText(textOf(el))

    case 'f': {
      const num = firstChild(el, 'num')
      const den = firstChild(el, 'den')
      return `\\frac{${num ? convertNode(num) : ''}}{${den ? convertNode(den) : ''}}`
    }

    case 'sSup': {
      const e = firstChild(el, 'e')
      const sup = firstChild(el, 'sup')
      return `{${e ? convertNode(e) : ''}}^{${sup ? convertNode(sup) : ''}}`
    }

    case 'sSub': {
      const e = firstChild(el, 'e')
      const sub = firstChild(el, 'sub')
      return `{${e ? convertNode(e) : ''}}_{${sub ? convertNode(sub) : ''}}`
    }

    case 'sSubSup': {
      const e = firstChild(el, 'e')
      const sub = firstChild(el, 'sub')
      const sup = firstChild(el, 'sup')
      return `{${e ? convertNode(e) : ''}}_{${sub ? convertNode(sub) : ''}}^{${sup ? convertNode(sup) : ''}}`
    }

    case 'sPre': {
      const e = firstChild(el, 'e')
      const sub = firstChild(el, 'sub')
      const sup = firstChild(el, 'sup')
      const pre = [
        sub ? `_{${convertNode(sub)}}` : '',
        sup ? `^{${convertNode(sup)}}` : '',
      ].join('')
      return `{}${pre}{${e ? convertNode(e) : ''}}`
    }

    case 'rad': {
      const deg = firstChild(el, 'deg')
      const e = firstChild(el, 'e')
      const body = e ? convertNode(e) : ''
      if (deg && textOf(deg).trim()) {
        return `\\sqrt[${convertNode(deg)}]{${body}}`
      }
      return `\\sqrt{${body}}`
    }

    case 'nary': {
      const naryPr = firstChild(el, 'naryPr')
      const chrEl = naryPr ? firstChild(naryPr, 'chr') : null
      const chr =
        chrEl?.getAttribute('m:val') ||
        chrEl?.getAttributeNS?.(NS.m, 'val') ||
        chrEl?.getAttribute('val') ||
        '∑'
      const op =
        chr === '∑'
          ? '\\sum'
          : chr === '∏'
            ? '\\prod'
            : chr === '∫'
              ? '\\int'
              : escapeLatexText(chr)
      const sub = firstChild(el, 'sub')
      const sup = firstChild(el, 'sup')
      const e = firstChild(el, 'e')
      return `${op}_{${sub ? convertNode(sub) : ''}}^{${sup ? convertNode(sup) : ''}}{${e ? convertNode(e) : ''}}`
    }

    case 'd': {
      const dPr = firstChild(el, 'dPr')
      const begEl = dPr ? firstChild(dPr, 'begChr') : null
      const endEl = dPr ? firstChild(dPr, 'endChr') : null
      const beg =
        begEl?.getAttribute('m:val') ||
        begEl?.getAttributeNS?.(NS.m, 'val') ||
        begEl?.getAttribute('val') ||
        '('
      const end =
        endEl?.getAttribute('m:val') ||
        endEl?.getAttributeNS?.(NS.m, 'val') ||
        endEl?.getAttribute('val') ||
        ')'
      const inner = children(el, 'e').map(convertNode).join('')
      const wrap = (open: string, close: string) =>
        `\\left${open === '{' ? '\\{' : open}${inner}\\right${close === '}' ? '\\}' : close}`
      if (beg === '(' && end === ')') return wrap('(', ')')
      if (beg === '[' && end === ']') return wrap('[', ']')
      if (beg === '{' && end === '}') return wrap('{', '}')
      if (beg === '|' && end === '|') return `\\left|${inner}\\right|`
      return wrap(beg || '(', end || ')')
    }

    case 'func': {
      const fName = firstChild(el, 'fName')
      const e = firstChild(el, 'e')
      const nameText = (fName ? convertNode(fName) : '').trim()
      const arg = e ? convertNode(e) : ''
      if (KNOWN_FUNCS.has(nameText)) {
        return `\\${nameText}{${arg}}`
      }
      return `${nameText}\\left(${arg}\\right)`
    }

    case 'limLow': {
      const e = firstChild(el, 'e')
      const lim = firstChild(el, 'lim')
      return `\\underset{${lim ? convertNode(lim) : ''}}{${e ? convertNode(e) : ''}}`
    }

    case 'limUpp': {
      const e = firstChild(el, 'e')
      const lim = firstChild(el, 'lim')
      return `\\overset{${lim ? convertNode(lim) : ''}}{${e ? convertNode(e) : ''}}`
    }

    case 'bar': {
      const e = firstChild(el, 'e')
      return `\\overline{${e ? convertNode(e) : ''}}`
    }

    case 'acc': {
      const e = firstChild(el, 'e')
      const accPr = firstChild(el, 'accPr')
      const chrEl = accPr ? firstChild(accPr, 'chr') : null
      const chr =
        chrEl?.getAttribute('m:val') ||
        chrEl?.getAttributeNS?.(NS.m, 'val') ||
        chrEl?.getAttribute('val') ||
        '^'
      const body = e ? convertNode(e) : ''
      if (chr === '̂' || chr === '^') return `\\hat{${body}}`
      if (chr === '̃' || chr === '~') return `\\tilde{${body}}`
      if (chr === '¯') return `\\bar{${body}}`
      if (chr === '̇') return `\\dot{${body}}`
      if (chr === '̈') return `\\ddot{${body}}`
      if (chr === '⃗') return `\\vec{${body}}`
      return `\\hat{${body}}`
    }

    case 'm': {
      const rows = children(el, 'mr')
      const body = rows
        .map((row) => children(row, 'e').map(convertNode).join(' & '))
        .join(' \\\\ ')
      return `\\begin{matrix}${body}\\end{matrix}`
    }

    case 'box':
    case 'borderBox':
    case 'groupChr':
    case 'phant':
      return convertChildren(el)

    default:
      // Skip property elements; otherwise recurse
      if (name.endsWith('Pr') || name === 'ctrlPr') return ''
      if (el.children.length > 0) return convertChildren(el)
      return escapeLatexText(textOf(el))
  }
}

/** Parse an OMML fragment (oMath / oMathPara or inner XML) to LaTeX. */
export function ommlXmlToLatex(ommlXml: string): string {
  const wrapped = ommlXml.includes('<')
    ? `<?xml version="1.0"?><root xmlns:m="${NS.m}" xmlns:w="${NS.w}">${ommlXml}</root>`
    : ommlXml

  const parser =
    typeof DOMParser !== 'undefined' ? new DOMParser() : new XmldomParser()

  const doc = parser.parseFromString(wrapped, 'application/xml')
  const err =
    typeof doc.getElementsByTagName === 'function'
      ? doc.getElementsByTagName('parsererror')
      : []
  if (err.length) {
    return ommlXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const root = doc.documentElement as unknown as Element
  const math = findMathElement(root)
  return convertNode(math).replace(/\s+/g, ' ').trim()
}

function findMathElement(root: Element): Element {
  const walk = (el: Element): Element | null => {
    const n = localName(el)
    if (n === 'oMath' || n === 'oMathPara') return el
    for (const c of elementChildren(el)) {
      const found = walk(c)
      if (found) return found
    }
    return null
  }
  return walk(root) ?? root
}
