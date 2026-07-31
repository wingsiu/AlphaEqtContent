import JSZip from 'jszip'
import { ommlXmlToLatex } from './ommlToLatex'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function latexTextRun(latex: string, block: boolean): string {
  const delim = block ? '$$' : '$'
  return `<w:r><w:t xml:space="preserve">${delim}${escapeXml(latex)}${delim}</w:t></w:r>`
}

function plainTextRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}

function isMathTypeOle(block: string): boolean {
  return /ProgID\s*=\s*"[^"]*Equation/i.test(block) || /Equation\.DSMT/i.test(block)
}

/**
 * Replace Word OMML with `$latex$`, and MathType OLE objects with visible
 * `⟦MathType N⟧` markers (OLE/MTEF is not OMML — type LaTeX over the markers).
 */
export async function injectLatexIntoDocx(arrayBuffer: ArrayBuffer): Promise<{
  buffer: ArrayBuffer
  equationCount: number
  mathtypeCount: number
}> {
  const zip = await JSZip.loadAsync(arrayBuffer)
  let equationCount = 0
  let mathtypeCount = 0

  const targets = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']

  for (const path of targets) {
    const file = zip.file(path)
    if (!file) continue

    let xml = await file.async('string')

    // --- Native Word math (OMML) → LaTeX ---
    xml = xml.replace(
      /<(?:m:)?oMathPara\b[^>]*>[\s\S]*?<\/(?:m:)?oMathPara>/gi,
      (block) => {
        const inners = block.match(/<(?:m:)?oMath\b[^>]*>[\s\S]*?<\/(?:m:)?oMath>/gi) ?? [
          block,
        ]
        const runs = inners.map((omath) => {
          equationCount += 1
          return latexTextRun(ommlXmlToLatex(omath), true)
        })
        return `<w:p>${runs.join('')}</w:p>`
      },
    )

    xml = xml.replace(/<(?:m:)?oMath\b[^>]*>[\s\S]*?<\/(?:m:)?oMath>/gi, (omath) => {
      equationCount += 1
      return latexTextRun(ommlXmlToLatex(omath), false)
    })

    // --- MathType / Equation Editor OLE → placeholder to type over ---
    xml = xml.replace(/<w:object\b[\s\S]*?<\/w:object>/gi, (block) => {
      if (!isMathTypeOle(block)) return block
      mathtypeCount += 1
      return plainTextRun(`⟦MathType ${mathtypeCount}⟧`)
    })

    // Some Word builds nest OLE inside w:pict
    xml = xml.replace(/<w:pict\b[\s\S]*?<\/w:pict>/gi, (block) => {
      if (!isMathTypeOle(block)) return block
      mathtypeCount += 1
      return plainTextRun(`⟦MathType ${mathtypeCount}⟧`)
    })

    zip.file(path, xml)
  }

  // Fallback count from embeddings if XML ProgID was missing but bins exist
  if (mathtypeCount === 0) {
    const oleBins = Object.keys(zip.files).filter((p) =>
      /^word\/embeddings\/oleObject\d+\.bin$/i.test(p),
    )
    if (oleBins.length > 0) {
      mathtypeCount = oleBins.length
    }
  }

  const buffer = await zip.generateAsync({ type: 'arraybuffer' })
  return { buffer, equationCount, mathtypeCount }
}
