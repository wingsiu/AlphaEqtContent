import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { parseDocParts, type DocPart } from './EditorPartZoom'
import { upsertPageMarkdown } from './ocrClient'
import { stripFormulaPartMarkers } from './mathFormat'

export type CropRegion = {
  qid: string
  question: DocPart // number-item stem (legacy field name for API)
  options: DocPart | null // option group
  figure: DocPart | null
}

type Box = [number, number, number, number]
type CropKind =
  | 'title'
  | 'number'
  | 'roman'
  | 'option'
  | 'normal'
  | 'figure'
  | 'formula'
  | 'ignored'
  // Legacy aliases still parsed from sample MD
  | 'question'
  | 'options'
  | 'instruction'

/** DocLayout-YOLO region kinds for layout-edit mode. */
type LayoutKind = 'title' | 'text' | 'figure' | 'table' | 'formula' | 'ignored'

export type LayoutRegionEdit = {
  kind: LayoutKind
  box: Box
  score?: number
}

export type MfdRegionEdit = {
  type: 'embedding' | 'isolated'
  box: Box
  score?: number
}

const LAYOUT_KIND_COLOR: Record<LayoutKind, string> = {
  title: '#a020f0',
  text: '#ff8c00',
  figure: '#005aff',
  table: '#dc14a0',
  formula: '#00b400',
  ignored: '#8c8c8c',
}

const MFD_COLOR = '#27ae60'

const KIND_COLOR: Record<CropKind, string> = {
  title: '#a020f0',
  number: '#e67e22',
  question: '#e67e22',
  roman: '#6b6458',
  normal: '#6b6458',
  instruction: '#6b6458',
  option: '#c0392b',
  options: '#c0392b',
  figure: '#2980b9',
  formula: '#27ae60',
  ignored: '#8c8c8c',
}

function canonKind(k: string): CropKind {
  if (k === 'question') return 'number'
  if (k === 'options') return 'option'
  if (k === 'instruction') return 'normal'
  return (k as CropKind) || 'normal'
}

function isNumberKind(k: string) {
  return k === 'number' || k === 'question'
}
function isOptionKind(k: string) {
  return k === 'option' || k === 'options'
}
function isListNoteKind(k: string) {
  return k === 'roman' || k === 'normal' || k === 'instruction'
}

/** Show @parts for this page. Prefer same-doc src, but never hide the page's crops. */
function isPartForCurrentDoc(
  p: DocPart,
  page: number,
  imageSrc: string,
  analysisSlug?: string | null,
): boolean {
  if (p.page !== page) return false
  const src = (p.src || '').trim()
  if (!src) return true
  if (imageSrc && (src === imageSrc || imageSrc.includes(src) || src.includes(imageSrc))) {
    return true
  }
  if (analysisSlug && src.includes(analysisSlug)) return true
  // Same paper slug under /samples/… or /imports/page-ocr/…
  const slugInImg = /\/(?:samples|page-ocr)\/([^/]+)/.exec(imageSrc || '')
  if (slugInImg && src.includes(slugInImg[1]!)) return true
  const slugInSrc = /\/(?:samples|page-ocr)\/([^/]+)/.exec(src)
  if (analysisSlug && slugInSrc && slugInSrc[1] === analysisSlug) return true
  // Still show crops for this page — image may be /samples while src is /imports
  if (!slugInSrc || !slugInImg || slugInSrc[1] === slugInImg[1]) return true
  return false
}

function boxKey(box: Box): string {
  return box.map((n) => Math.round(n)).join(',')
}

/** Safe ``url("…")`` for inline background-image styles. */
function cssBackgroundUrl(src: string): string {
  const escaped = src
    .replace(/\\/g, '/')
    .replace(/"/g, '%22')
    .replace(/\)/g, '%29')
  return `url("${escaped}")`
}

type VisionTextBlock = {
  text: string
  box: Box
  score?: number
}

type MfdVisionGeom = {
  box: Box
  type?: string
  latex?: string
}

type ComposeSpliceDebug = {
  visionKeep: VisionTextBlock[]
  mfdHoles: MfdVisionGeom[]
}

function boxArea(box: Box): number {
  return Math.max(1, (box[2] - box[0]) * (box[3] - box[1]))
}

function boxIou(a: Box, b: Box): number {
  const ix0 = Math.max(a[0], b[0])
  const iy0 = Math.max(a[1], b[1])
  const ix1 = Math.min(a[2], b[2])
  const iy1 = Math.min(a[3], b[3])
  if (ix1 <= ix0 || iy1 <= iy0) return 0
  const inter = (ix1 - ix0) * (iy1 - iy0)
  return inter / (boxArea(a) + boxArea(b) - inter)
}

function yBandOverlaps(a: Box, b: Box, slack = 12): boolean {
  return a[1] - slack <= b[3] && a[3] + slack >= b[1]
}

function boxCy(box: Box): number {
  return (box[1] + box[3]) / 2
}

/** Exclusive MFD→Vision-line assignment by nearest center-Y. */
function assignMfdsToBands(
  bandLboxes: Box[],
  mfdBoxes: Box[],
  slack = 8,
): number[][] {
  const out: number[][] = bandLboxes.map(() => [])
  for (let fi = 0; fi < mfdBoxes.length; fi++) {
    const fb = mfdBoxes[fi]!
    const fcy = boxCy(fb)
    let bestBi = -1
    let bestDist = Infinity
    for (let bi = 0; bi < bandLboxes.length; bi++) {
      const lbox = bandLboxes[bi]!
      if (fcy < lbox[1] - slack || fcy > lbox[3] + slack) continue
      const dist = Math.abs(fcy - boxCy(lbox))
      if (dist < bestDist) {
        bestDist = dist
        bestBi = bi
      }
    }
    if (bestBi >= 0) out[bestBi]!.push(fi)
  }
  return out
}

function mergeXIntervals(intervals: [number, number][]): [number, number][] {
  if (!intervals.length) return []
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = [[sorted[0]![0], sorted[0]![1]]]
  for (let i = 1; i < sorted.length; i++) {
    const [x0, x1] = sorted[i]!
    const last = out[out.length - 1]!
    if (x0 <= last[1] + 1) last[1] = Math.max(last[1], x1)
    else out.push([x0, x1])
  }
  return out
}

const MATH_CRUMB_LETTERS = new Set('abcdefghjkmnpqrstvwxyz')

function isMfdAdjacentMathCrumb(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^(and|or|then|if|the|of|a|an|is|are|in|on|to|for|by|with|figure|diameter|circle|point|from|its|image|area)$/i.test(t)) {
    return false
  }
  if (/^[a-zA-Z]\s*=\s*[a-zA-Z]?$/.test(t)) return true
  if (/^[a-zA-Z]\s*=$/.test(t)) return true
  if (/^[a-zA-Z]$/.test(t) && MATH_CRUMB_LETTERS.has(t.toLowerCase())) return true
  return false
}

function visionTextForXSegment(vbox: Box, text: string, seg: Box): string {
  const [vx0, , vx1] = vbox
  const sx0 = seg[0]
  const sx1 = seg[2]
  const vw = Math.max(1, vx1 - vx0)
  const n = text.length
  if (n === 0) return ''
  let a = Math.floor(((sx0 - vx0) / vw) * n)
  let b = Math.ceil(((sx1 - vx0) / vw) * n)
  a = Math.max(0, Math.min(n, a))
  b = Math.max(a, Math.min(n, b))
  return text.slice(a, b).trim()
}

function trimKeepSegmentTrailingMathCrumb(
  vbox: Box,
  text: string,
  seg: Box,
  minWidth = 3,
): Box | null {
  const segText = visionTextForXSegment(vbox, text, seg)
  if (!segText) return null
  const m = segText.match(/^(.*?)(?:\s+[a-zA-Z]\s*=\s*|\s+[a-zA-Z]\s*)$/)
  if (!m) return seg
  const prose = (m[1] || '').trimEnd()
  if (prose.length < 2) return null
  const crumb = segText.slice(prose.length).trim()
  if (!isMfdAdjacentMathCrumb(crumb)) return seg
  const [sx0, sy0, sx1, sy1] = seg
  const frac = prose.length / Math.max(1, segText.length)
  const newX1 = sx0 + (sx1 - sx0) * frac
  if (newX1 - sx0 < minWidth) return null
  return [sx0, sy0, newX1, sy1]
}

function refineKeepSegmentsForMfd(
  vbox: Box,
  text: string,
  segments: Box[],
  mfdBoxes: Box[],
  minWidth = 3,
): Box[] {
  if (!segments.length) return segments
  const [vx0, , vx1] = vbox
  const onLine = mfdBoxes.filter((mb) => yBandOverlaps(vbox, mb))
  const holes = mergeXIntervals(
    onLine
      .map((mb) => {
        const x0 = Math.max(vx0, mb[0])
        const x1 = Math.min(vx1, mb[2])
        return [x0, x1] as [number, number]
      })
      .filter(([x0, x1]) => x1 - x0 >= minWidth),
  )
  const out: Box[] = []
  for (const seg of segments) {
    let refined: Box | null = seg
    for (const [hx0] of holes) {
      if (Math.abs(seg[2] - hx0) <= 8 && refined) {
        refined = trimKeepSegmentTrailingMathCrumb(vbox, text, refined, minWidth)
      }
    }
    if (!refined) continue
    const segText = visionTextForXSegment(vbox, text, refined)
    if (segText && isMfdAdjacentMathCrumb(segText)) continue
    if (refined[2] - refined[0] >= minWidth) out.push(refined)
  }
  return out
}

function visionBlockIsMfdMathCrumb(b: VisionTextBlock, mfdBoxes: Box[], gap = 24): boolean {
  if (!isMfdAdjacentMathCrumb((b.text || '').trim())) return false
  const bx0 = b.box[0]
  const bx1 = b.box[2]
  for (const mb of mfdBoxes) {
    if (!yBandOverlaps(b.box, mb)) continue
    const mx0 = mb[0]
    const mx1 = mb[2]
    if (bx1 <= mx0 + 4 && bx1 >= mx0 - gap) return true
    if (bx0 >= mx1 - 4 && bx0 <= mx1 + gap) return true
    if (bx0 <= mx0 && bx1 >= mx1) return true
  }
  return false
}

/** Path A Keep: Vision x-segments outside same-band MFD holes only.
 * Empty Keep stays empty — do not drop by size or missing text.
 */
function splitVisionKeepSegments(
  vbox: Box,
  mfdBoxes: Box[],
  minWidth = 0,
): Box[] {
  const [vx0, vy0, vx1, vy1] = vbox
  const onLine = mfdBoxes.filter((mb) => yBandOverlaps(vbox, mb))
  if (!onLine.length) return [vbox]

  const holes = mergeXIntervals(
    onLine
      .map((mb) => {
        const x0 = Math.max(vx0, mb[0])
        const x1 = Math.min(vx1, mb[2])
        return [x0, x1] as [number, number]
      })
      .filter(([x0, x1]) => x1 - x0 > 0),
  )
  if (!holes.length) return [vbox]

  const keep: Box[] = []
  let cursor = vx0
  for (const [hx0, hx1] of holes) {
    if (hx0 > cursor + minWidth) {
      keep.push([cursor, vy0, hx0, vy1])
    }
    cursor = Math.max(cursor, hx1)
  }
  if (vx1 > cursor + minWidth) {
    keep.push([cursor, vy0, vx1, vy1])
  }
  return keep
}

function matchLatexForMfdBox(
  mfdBox: Box,
  hints: { box: Box; latex: string }[],
): string | undefined {
  let bestIou = 0
  let bestLatex: string | undefined
  for (const h of hints) {
    const iou = boxIou(mfdBox, h.box)
    if (iou > bestIou) {
      bestIou = iou
      bestLatex = h.latex.trim() || undefined
    }
  }
  return bestIou >= 0.15 ? bestLatex : undefined
}

/** Prefer full page Vision OCR for Keep overlay (not pre-filtered stem). */
function extractVisionFromAnalysis(data: {
  compose?: {
    vision_stem?: { text?: string; box?: number[]; score?: number }[]
    vision_raw?: { text?: string; box?: number[]; score?: number }[]
    regions?: {
      kind?: string
      vision?: { text?: string; box?: number[]; score?: number }[]
    }[]
  }
  vision_text?: { text?: string; box?: number[]; score?: number }[]
}): VisionTextBlock[] {
  if (data.vision_text?.length) {
    return parseVisionTextBlocks(data.vision_text)
  }
  if (data.compose?.vision_raw?.length) {
    return parseVisionTextBlocks(data.compose.vision_raw)
  }
  if (data.compose?.vision_stem?.length) {
    return parseVisionTextBlocks(data.compose.vision_stem)
  }
  if (data.compose?.regions?.length) {
    const seen = new Set<string>()
    const out: VisionTextBlock[] = []
    for (const reg of data.compose.regions) {
      for (const blk of parseVisionTextBlocks(reg.vision)) {
        const key = boxKey(blk.box)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(blk)
      }
    }
    if (out.length) return out
  }
  return []
}

function extractMfdLatexHints(data: {
  compose?: {
    splice?: {
      mfd_detection?: { box?: number[]; latex?: string }[]
    }
  }
  formulas?: { box?: number[]; text?: string }[]
}): { box: Box; latex: string }[] {
  const det = data.compose?.splice?.mfd_detection
  if (det?.length) {
    const out: { box: Box; latex: string }[] = []
    for (const d of det) {
      if (!d.box || d.box.length !== 4) continue
      out.push({
        box: [d.box[0]!, d.box[1]!, d.box[2]!, d.box[3]!],
        latex: (d.latex || '').trim(),
      })
    }
    if (out.length) return out
  }
  const out: { box: Box; latex: string }[] = []
  for (const f of data.formulas || []) {
    if (!f.box || f.box.length !== 4) continue
    out.push({
      box: [f.box[0]!, f.box[1]!, f.box[2]!, f.box[3]!],
      latex: (f.text || '').trim(),
    })
  }
  return out
}

function pushKeepSegments(
  dest: VisionTextBlock[],
  seen: Set<string>,
  source: VisionTextBlock,
  segments: Box[],
) {
  for (const seg of segments) {
    const key = boxKey(seg)
    if (seen.has(key)) continue
    seen.add(key)
    const sameBox =
      seg[0] === source.box[0] &&
      seg[1] === source.box[1] &&
      seg[2] === source.box[2] &&
      seg[3] === source.box[3]
    // Empty Keep stays empty — do not fall back in a way that hides emptiness
    const text = sameBox
      ? source.text ?? ''
      : visionTextForXSegment(source.box, source.text, seg)
    dest.push({ ...source, text: text ?? '', box: seg })
  }
}

function keepBoxesFromLayoutBands(bandLboxes: Box[], layoutBox: Box): Box[] {
  if (!bandLboxes.length) return []
  const [lx0, ly0, lx1, ly1] = layoutBox
  const n = bandLboxes.length
  const out: Box[] = []
  for (let i = 0; i < n; i++) {
    const lb = bandLboxes[i]!
    const cy = boxCy(lb)
    let y0 = i === 0 ? ly0 : (boxCy(bandLboxes[i - 1]!) + cy) / 2
    let y1 = i === n - 1 ? ly1 : (cy + boxCy(bandLboxes[i + 1]!)) / 2
    if (y1 <= y0 + 1) {
      y0 = lb[1]
      y1 = lb[3]
    }
    out.push([lx0, y0, lx1, y1])
  }
  return out
}

/**
 * Path A overlay: for every Vision text line in a layout text/title region,
 * Keep = full text-region width (left→right margin) outside same-band MFD holes.
 * Hole = MFD box. Same-baseline Vision tokens are merged into one line first.
 */
function computeLiveSpliceDebug(
  visionBlocks: VisionTextBlock[],
  layoutRegions: LayoutRegionEdit[],
  mfdRegions: MfdRegionEdit[],
  latexHints: { box: Box; latex: string }[],
): ComposeSpliceDebug {
  const figBoxes = layoutRegions
    .filter((r) => r.kind === 'figure')
    .map((r) => r.box)
  const ignoredBoxes = layoutRegions
    .filter((r) => r.kind === 'ignored')
    .map((r) => r.box)

  const kept: VisionTextBlock[] = []
  const mfdHoles: MfdVisionGeom[] = []
  const seenKeep = new Set<string>()
  const seenHole = new Set<string>()

  const textRegions = layoutRegions.filter(
    (r) => r.kind === 'text' || r.kind === 'title',
  )

  for (const reg of textRegions) {
    const rb = reg.box
    const localMfd = mfdRegions.filter((m) =>
      pointInBox(boxCenter(m.box), rb, 6),
    )
    const mfdBoxes = localMfd.map((m) => m.box)

    for (const m of localMfd) {
      const holeKey = boxKey(m.box)
      if (seenHole.has(holeKey)) continue
      seenHole.add(holeKey)
      mfdHoles.push({
        box: m.box,
        type: m.type,
        latex: matchLatexForMfdBox(m.box, latexHints),
      })
    }

    const regionBlocks = visionBlocks.filter((blk) => {
      const c = boxCenter(blk.box)
      if (!pointInBox(c, rb, 8)) return false
      if (figBoxes.some((fb) => pointInBox(c, fb, 2))) return false
      if (ignoredBoxes.some((ib) => pointInBox(c, ib, 2))) return false
      return true
    })
    const lines = mergeVisionSameBaseline(regionBlocks)
    const bandLboxes = lines.map((b) => b.box)
    const keepBands = keepBoxesFromLayoutBands(bandLboxes, rb)
    const bandMfdIdxs = assignMfdsToBands(keepBands, mfdBoxes)

    for (let li = 0; li < lines.length; li++) {
      const b = lines[li]!
      const kbox = keepBands[li] ?? ([rb[0], b.box[1], rb[2], b.box[3]] as Box)
      const lineMfdBoxes = (bandMfdIdxs[li] ?? []).map((i) => mfdBoxes[i]!)
      const keepSegs = splitVisionKeepSegments(kbox, lineMfdBoxes)
      pushKeepSegments(kept, seenKeep, { ...b, box: kbox }, keepSegs)
    }
  }

  return { visionKeep: kept, mfdHoles }
}

function parseVisionTextBlocks(
  raw: { text?: string; box?: number[]; score?: number }[] | undefined,
): VisionTextBlock[] {
  const out: VisionTextBlock[] = []
  for (const r of raw || []) {
    if (!r.box || r.box.length !== 4) continue
    const text = (r.text || '').trim()
    if (!text) continue
    out.push({
      text,
      box: [r.box[0]!, r.box[1]!, r.box[2]!, r.box[3]!],
      score: r.score,
    })
  }
  return out
}

function boxCenter(box: Box): [number, number] {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
}

/** Group Vision tokens on the same baseline (center-Y), any horizontal gap. */
function bandVisionLines(blocks: VisionTextBlock[]): VisionTextBlock[][] {
  if (!blocks.length) return []
  const heights = blocks.map((b) => Math.max(8, b.box[3] - b.box[1]))
  const sorted = [...heights].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const med =
    sorted.length % 2
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2
  // Same printed line only; tall-fraction stems merge via MFD span, not this.
  const band = Math.max(10, med * 0.45)
  const items = [...blocks].sort(
    (a, b) => boxCenter(a.box)[1] - boxCenter(b.box)[1] || a.box[0] - b.box[0],
  )
  const lines: VisionTextBlock[][] = []
  let cur: VisionTextBlock[] = []
  let curY: number | null = null
  for (const b of items) {
    const y = boxCenter(b.box)[1]
    if (curY === null || Math.abs(y - curY) < band) {
      cur.push(b)
      curY = curY === null ? y : 0.65 * curY + 0.35 * y
    } else {
      lines.push(cur)
      cur = [b]
      curY = y
    }
  }
  if (cur.length) lines.push(cur)
  return lines
}

/** Merge same-baseline Vision tokens into one line (union box + joined text). */
function mergeVisionSameBaseline(blocks: VisionTextBlock[]): VisionTextBlock[] {
  const out: VisionTextBlock[] = []
  for (const line of bandVisionLines(blocks)) {
    if (line.length === 1) {
      out.push(line[0]!)
      continue
    }
    const ordered = [...line].sort((a, b) => a.box[0] - b.box[0])
    const parts = ordered
      .map((b) => (b.text || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((t) => (/^\d{1,3}$/.test(t) ? `${t}.` : t))
    if (!parts.length) continue
    const x0 = Math.min(...ordered.map((b) => b.box[0]))
    const y0 = Math.min(...ordered.map((b) => b.box[1]))
    const x1 = Math.max(...ordered.map((b) => b.box[2]))
    const y1 = Math.max(...ordered.map((b) => b.box[3]))
    const score = Math.max(...ordered.map((b) => b.score ?? 0))
    out.push({ text: parts.join(' '), box: [x0, y0, x1, y1], score })
  }
  return out
}

function pointInBox(pt: [number, number], box: Box, pad = 0): boolean {
  return pt[0] >= box[0] - pad && pt[0] <= box[2] + pad && pt[1] >= box[1] - pad && pt[1] <= box[3] + pad
}

function parseMfdRegions(
  raw: { type?: string; box?: number[]; score?: number }[] | undefined,
): MfdRegionEdit[] {
  const out: MfdRegionEdit[] = []
  for (const m of raw || []) {
    if (!m.box || m.box.length !== 4) continue
    out.push({
      type: m.type === 'isolated' ? 'isolated' : 'embedding',
      box: [m.box[0]!, m.box[1]!, m.box[2]!, m.box[3]!],
      score: m.score,
    })
  }
  return out
}

function resolveLayoutFromAnalysis(
  data: {
    layout?: { kind?: string; box?: number[]; score?: number }[]
    layout_corrected?: { kind?: string; box?: number[]; score?: number }[]
  },
  initialLayout?: LayoutRegionEdit[] | null,
): LayoutRegionEdit[] {
  if (initialLayout?.length) return initialLayout
  const corrected = parseLayoutRegions(data.layout_corrected)
  if (corrected.length) return corrected
  return parseLayoutRegions(data.layout)
}

function resolveMfdSeed(
  data: {
    mfd_corrected?: { type?: string; box?: number[]; score?: number }[]
    mfd?: { type?: string; box?: number[]; score?: number }[]
    formulas?: { box?: number[]; score?: number }[]
  },
  initialMfd?: MfdRegionEdit[] | null,
): MfdRegionEdit[] {
  if (initialMfd?.length) return initialMfd
  const corrected = parseMfdRegions(data.mfd_corrected)
  if (corrected.length) return corrected
  const mfdRaw = data.mfd
  if (mfdRaw?.length) return parseMfdRegions(mfdRaw)
  const formulaAsMfd = (data.formulas || [])
    .filter((f) => f.box && f.box.length === 4)
    .map((f) => ({
      type: 'embedding' as const,
      box: f.box!,
      score: f.score,
    }))
  return parseMfdRegions(formulaAsMfd)
}

function parseLayoutRegions(
  raw: { kind?: string; box?: number[]; score?: number }[] | undefined,
): LayoutRegionEdit[] {
  const allowed = new Set(['title', 'text', 'figure', 'table', 'formula', 'ignored'])
  const out: LayoutRegionEdit[] = []
  for (const r of raw || []) {
    if (!r.box || r.box.length !== 4) continue
    let kind = (r.kind || 'text').toLowerCase()
    if (kind === 'plain text' || kind === 'plain_text') kind = 'text'
    if (kind === 'abandon') kind = 'ignored'
    if (kind === 'list') kind = 'text'
    if (!allowed.has(kind)) kind = 'text'
    out.push({
      kind: kind as LayoutKind,
      box: [r.box[0]!, r.box[1]!, r.box[2]!, r.box[3]!],
      score: r.score,
    })
  }
  return out
}

/** Keep figure crops out of the question stem's vertical band (and options). */
function figureBoxAvoidingQuestion(
  fig: Box,
  question: Box | null | undefined,
  gap = 6,
): Box {
  if (!question) return fig
  let [x0, y0, x1, y1] = fig
  const [, qy0, , qy1] = question
  // Stem is often a full-width top line; figure must sit below that band
  if (y0 < qy1 + gap && y1 > qy0) {
    y0 = Math.max(y0, qy1 + gap)
    if (y1 - y0 < 16) y1 = y0 + 16
  }
  return [x0, y0, x1, y1]
}

function figureBoxAvoidingOptions(
  fig: Box,
  options: Box | null | undefined,
  gap = 6,
): Box {
  if (!options) return fig
  let [x0, y0, x1, y1] = fig
  const [ox0, oy0, ox1, oy1] = options
  const overlaps =
    x0 < ox1 - gap && x1 > ox0 + gap && y0 < oy1 - gap && y1 > oy0 + gap
  if (!overlaps) return fig
  x0 = Math.max(x0, ox1 + gap)
  if (x1 - x0 < 16) x1 = x0 + 16
  return [x0, y0, x1, y1]
}

function groupPageRegions(parts: DocPart[], page: number): CropRegion[] {
  // Sort by reading order (T→B, L→R) then attach option/figure after each number
  const pageParts = parts
    .filter(
      (p) =>
        p.page === page &&
        (isNumberKind(p.kind) ||
          isOptionKind(p.kind) ||
          p.kind === 'figure' ||
          p.kind === 'roman'),
    )
    .slice()
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])

  const regions: CropRegion[] = []
  let cur: CropRegion | null = null
  const usedFigureIdx = new Set<number>()
  const usedOptionsIdx = new Set<number>()

  for (const p of pageParts) {
    if (isNumberKind(p.kind)) {
      if (cur) regions.push(cur)
      cur = { qid: p.id, question: p, options: null, figure: null }
    } else if (cur) {
      if (isOptionKind(p.kind) && !cur.options) {
        cur.options = p
        usedOptionsIdx.add(p.index)
      }
      if (p.kind === 'figure' && !cur.figure) {
        cur.figure = p
        usedFigureIdx.add(p.index)
      }
      // roman list sits between stem and options — does not start a region
    } else if (isOptionKind(p.kind)) {
      // orphan option — synthetic stem below
    }
  }
  if (cur) regions.push(cur)

  // Orphan figures: attach to nearest number by y
  for (const p of pageParts) {
    if (p.kind !== 'figure' || usedFigureIdx.has(p.index)) continue
    const fcy = (p.box[1] + p.box[3]) / 2
    let best: CropRegion | null = null
    let bestDist = Infinity
    for (const r of regions) {
      const q = r.question.box
      const qcy = (q[1] + q[3]) / 2
      const dist =
        fcy >= q[1] - 20 ? fcy - qcy : Math.abs(fcy - qcy) + 10_000
      if (dist < bestDist) {
        bestDist = dist
        best = r
      }
    }
    if (best && !best.figure) {
      best.figure = p
      usedFigureIdx.add(p.index)
    } else if (best) {
      regions.push({
        qid: `${best.qid}-fig2`,
        question: best.question,
        options: null,
        figure: p,
      })
      usedFigureIdx.add(p.index)
    }
  }

  // Orphan options (no number @part) — still rebuildable
  for (const p of pageParts) {
    if (!isOptionKind(p.kind) || usedOptionsIdx.has(p.index)) continue
    if (regions.some((r) => r.options?.index === p.index)) continue
    const [x0, y0, x1] = p.box
    const stemH = Math.min(280, Math.max(80, y0 * 0.35))
    regions.push({
      qid: `opts-${p.index}`,
      question: {
        kind: 'number',
        id: `stem-${p.index}`,
        page,
        box: [x0, Math.max(0, y0 - stemH), x1, Math.max(16, y0 - 6)],
        src: p.src,
        color: KIND_COLOR.number,
        index: -1 - p.index,
      },
      options: p,
      figure: null,
    })
  }
  return regions
}

function updatePartBoxAt(md: string, partIndex: number, box: Box): string {
  const [x0, y0, x1, y1] = box.map((n) => Math.round(n))
  const slice = md.slice(partIndex, Math.min(md.length, partIndex + 280))
  const m = /box=([\d.,-]+)/.exec(slice)
  if (!m || m.index === undefined) return md
  const start = partIndex + m.index
  return `${md.slice(0, start)}box=${x0},${y0},${x1},${y1}${md.slice(start + m[0].length)}`
}

/** Replace the markdown body under an @part comment (for live crop OCR preview). */
function updatePartBodyAt(md: string, partIndex: number, body: string): string {
  if (partIndex < 0) return md
  const parts = parseDocParts(md)
  const self = parts.find((p) => p.index === partIndex)
  if (!self) return md
  const commentEnd = md.indexOf('-->', self.index)
  if (commentEnd < 0) return md
  let bodyStart = commentEnd + 3
  while (bodyStart < md.length && /[ \t\r\n]/.test(md[bodyStart]!)) bodyStart += 1
  const nextPart = parts.find((p) => p.index > self.index)
  const nextHeading = md.slice(bodyStart).search(/^##\s/m)
  let bodyEnd = md.length
  if (nextPart) bodyEnd = Math.min(bodyEnd, nextPart.index)
  if (nextHeading >= 0) bodyEnd = Math.min(bodyEnd, bodyStart + nextHeading)
  if (self.kind === 'formula') {
    // Formula markers are body-less — nothing to replace
    return md
  }
  if (self.kind === 'title') {
    const hm = /^##[^\n]*/.exec(md.slice(bodyStart))
    if (!hm) return md
    const titleLine = `## ${body.replace(/^#+\s*/, '').trim() || '…'}`
    return (
      md.slice(0, bodyStart) +
      titleLine +
      md.slice(bodyStart + hm[0].length)
    )
  }
  const cleaned = body.trim()
  const prefix = md.slice(commentEnd + 3, bodyStart)
  const suffixGap = md.slice(bodyEnd).startsWith('\n') ? '' : '\n'
  return (
    md.slice(0, commentEnd + 3) +
    (prefix.includes('\n') ? prefix : '\n\n') +
    cleaned +
    '\n' +
    suffixGap +
    md.slice(bodyEnd).replace(/^\n+/, '\n\n')
  )
}

/** Retarget @part kind=… (e.g. question → instruction for I–III crops). */
function updatePartKindAt(md: string, partIndex: number, kind: CropKind): string {
  if (partIndex < 0) return md
  const slice = md.slice(partIndex, Math.min(md.length, partIndex + 200))
  const m =
    /\bkind=(title|instruction|normal|roman|question|number|options|option|figure|formula)\b/.exec(
      slice,
    )
  if (!m || m.index === undefined) return md
  const start = partIndex + m.index
  return `${md.slice(0, start)}kind=${kind}${md.slice(start + m[0].length)}`
}

function looksLikeRomanListMd(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^-\s+(?:I{1,3}|IV)\.\s/m.test(t)) return true
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  return (
    lines.length >= 1 &&
    lines.every(
      (l) =>
        /^(?:I{1,3}|IV)\.\s/.test(l) ||
        /^-\s+(?:I{1,3}|IV)\.\s/.test(l) ||
        /^[pqr]\s*[<>≤≥=]/.test(l),
    )
  )
}

function removePartSection(md: string, part: DocPart): string {
  // Synthetic orphan-stem boxes (negative index) — nothing to delete in MD
  if (part.index < 0) return md
  const parts = parseDocParts(md)
  // Prefer exact index — many instructions share id=note
  const self =
    parts.find((p) => p.index === part.index) ||
    parts.find(
      (p) =>
        p.page === part.page &&
        p.kind === part.kind &&
        p.id === part.id &&
        Math.abs(p.index - part.index) < 8,
    )
  if (!self) return md
  const commentEnd = md.indexOf('-->', self.index)
  if (commentEnd < 0) return md
  let bodyStart = commentEnd + 3
  while (bodyStart < md.length && /[ \t\r\n]/.test(md[bodyStart]!)) bodyStart += 1
  const nextPart = parts.find((p) => p.index > self.index)
  const nextHeading = md.slice(bodyStart).search(/^##\s/m)
  let bodyEnd = md.length
  if (nextPart) bodyEnd = Math.min(bodyEnd, nextPart.index)
  if (nextHeading >= 0) bodyEnd = Math.min(bodyEnd, bodyStart + nextHeading)
  // Formula parts are markers only — don't eat following question text
  if (self.kind === 'formula') {
    bodyEnd = commentEnd + 3
    while (bodyEnd < md.length && md[bodyEnd] === '\n') bodyEnd += 1
  }
  // Title body is the following ## heading line
  if (self.kind === 'title') {
    const hm = /^##[^\n]*/.exec(md.slice(bodyStart))
    bodyEnd = hm ? bodyStart + hm[0].length : commentEnd + 3
    if (nextPart) bodyEnd = Math.min(bodyEnd, nextPart.index)
    while (bodyEnd < md.length && md[bodyEnd] === '\n') bodyEnd += 1
  }
  return (md.slice(0, self.index) + md.slice(bodyEnd)).replace(/\n{3,}/g, '\n\n')
}

function insertPartComment(
  md: string,
  page: number,
  kind: CropKind,
  box: Box,
  src: string,
  body?: string,
): string {
  const [x0, y0, x1, y1] = box.map((n) => Math.round(n))
  const id =
    isOptionKind(kind)
      ? 'A-D'
      : kind === 'figure'
        ? 'figure'
        : kind === 'formula'
          ? `f${Date.now() % 100000}`
          : kind === 'title'
            ? `t${Date.now() % 100000}`
            : isListNoteKind(kind)
              ? `i${Date.now() % 100000}`
              : `q${Date.now() % 100000}`
  const writeKind = canonKind(kind)
  const color = KIND_COLOR[writeKind] || KIND_COLOR.normal
  let block =
    `<!-- @part kind=${writeKind} id=${id} page=${page} ` +
    `box=${x0},${y0},${x1},${y1} src="${src}" color=${color} -->\n\n`
  if (body?.trim()) {
    if (kind === 'title') {
      block += `## ${body.trim().replace(/^##\s*/, '')}\n\n`
    } else {
      block += `${body.trim()}\n\n`
    }
  }
  // Ensure ## Page N exists and is in numeric order (not appended after p15)
  if (!new RegExp(`^## Page ${page}\\b`, 'm').test(md)) {
    md = upsertPageMarkdown(md, page, `## Page ${page}\n\n`)
  }
  const heading = new RegExp(`^## Page ${page}\\b.*$`, 'm')
  const m = heading.exec(md)
  if (!m || m.index === undefined) {
    return `${md.trimEnd()}\n\n## Page ${page}\n\n${block}`
  }
  const afterHeading = m.index + m[0].length
  const rest = md.slice(afterHeading)
  const next = rest.search(/^## Page \d+\b/m)
  const pageEnd = next >= 0 ? afterHeading + next : md.length
  // Titles belong at the top of the page section
  if (kind === 'title') {
    return md.slice(0, afterHeading) + '\n\n' + block + md.slice(afterHeading)
  }
  // Insert by reading order (top→bottom, then left→right) — not always at end
  const pageParts = parseDocParts(md).filter((p) => p.page === page)
  let insertAt = pageEnd
  for (const p of pageParts) {
    const [px, py] = p.box
    if (py > y0 + 1 || (Math.abs(py - y0) <= 1 && px > x0 + 1)) {
      insertAt = p.index
      break
    }
  }
  return md.slice(0, insertAt).trimEnd() + '\n\n' + block + md.slice(insertAt)
}

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'move'

type DragState = {
  partIndex: number
  kind: CropKind
  handle: Handle
  startBox: Box
  startX: number
  startY: number
}

type LayoutDragState = {
  layoutIndex: number
  kind: LayoutKind
  handle: Handle
  startBox: Box
  startX: number
  startY: number
}

type MfdDragState = {
  mfdIndex: number
  handle: Handle
  startBox: Box
  startX: number
  startY: number
}

type Props = {
  markdown: string
  page: number
  imageSrc: string
  analysisSlug?: string | null
  onMarkdownChange: (md: string) => void
  /** Full-height stage for modal use (no 520px cap). */
  fillViewport?: boolean
  onClose?: () => void
  /** Status line for layout edit / OCR. */
  onStatus?: (msg: string) => void
  onSaveLayout?: (regions: LayoutRegionEdit[]) => void | Promise<void>
  onRerunWithLayout?: (
    regions: LayoutRegionEdit[],
    mfd: MfdRegionEdit[],
  ) => void | Promise<void>
  onTrainLayout?: () => void | Promise<void>
  layoutBusy?: boolean
  layoutTrainPairs?: number
  /** Known page pixel size (from detect/analysis) — avoid 1×1 flash before img load. */
  imageSize?: { w: number; h: number } | null
  /** Seed layout+MFD from /page/detect/ (training pause). */
  initialLayout?: LayoutRegionEdit[] | null
  initialMfd?: MfdRegionEdit[] | null
  trainingSession?: boolean
  onConfirmContinue?: (
    layout: LayoutRegionEdit[],
    mfd: MfdRegionEdit[],
  ) => void | Promise<void>
}


/** Layout + MFD editor (Path A assemble). No separate @part crop mode. */
export function PageCropEditor({
  markdown,
  page,
  imageSrc,
  analysisSlug,
  onMarkdownChange,
  fillViewport,
  onClose,
  onStatus,
  onSaveLayout,
  onRerunWithLayout,
  onTrainLayout,
  layoutBusy,
  layoutTrainPairs,
  imageSize,
  initialLayout,
  initialMfd,
  trainingSession,
  onConfirmContinue,
}: Props) {
  const parts = useMemo(
    () =>
      parseDocParts(markdown).filter(
        (p) =>
          p.kind !== 'formula' &&
          isPartForCurrentDoc(p, page, imageSrc, analysisSlug),
      ),
    [markdown, page, imageSrc, analysisSlug],
  )
  const regions = useMemo(() => groupPageRegions(parts, page), [parts, page])
  const titleParts = useMemo(
    () => parts.filter((p) => p.kind === 'title'),
    [parts],
  )
  const instructionParts = useMemo(
    () => parts.filter((p) => isListNoteKind(p.kind)),
    [parts],
  )

  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const markdownRef = useRef(markdown)
  markdownRef.current = markdown
  const regionsRef = useRef(regions)
  regionsRef.current = regions
  /** User-deleted instruction boxes — don't re-seed from analysis. */
  const dismissedInstrRef = useRef<Set<string>>(new Set())
  /** User-deleted formula boxes — don't re-seed from analysis. */
  const dismissedFormulaRef = useRef<Set<string>>(new Set())

  const [natural, setNatural] = useState({
    w: imageSize?.w && imageSize.w > 1 ? imageSize.w : 1,
    h: imageSize?.h && imageSize.h > 1 ? imageSize.h : 1,
  })
  const [baseDisp, setBaseDisp] = useState(() => {
    const nw = imageSize?.w && imageSize.w > 1 ? imageSize.w : 0
    const nh = imageSize?.h && imageSize.h > 1 ? imageSize.h : 0
    if (nw < 2 || nh < 2) return { w: 1, h: 1 }
    // Seed a visible size before layout so the page isn't a 1×1 blank
    const fit = Math.min(1, 900 / nw)
    return { w: nw * fit, h: nh * fit }
  })
  const [imgFailed, setImgFailed] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [layoutRegions, setLayoutRegions] = useState<LayoutRegionEdit[]>(
    () => initialLayout || [],
  )
  const [mfdRegions, setMfdRegions] = useState<MfdRegionEdit[]>(
    () => initialMfd || [],
  )
  /** Once the user edits layout/MFD, never clobber from a late analysis fetch. */
  const layoutDirtyRef = useRef(!!(initialLayout?.length || initialMfd?.length))
  const [addLayoutKind, setAddLayoutKind] = useState<LayoutKind | null>(null)
  const [addMfdType, setAddMfdType] = useState<'embedding' | 'isolated' | null>(
    'embedding',
  )
  const [peekOverlays, setPeekOverlays] = useState(false)
  const [spliceOverlay, setSpliceOverlay] = useState(false)
  const [pageVisionBlocks, setPageVisionBlocks] = useState<VisionTextBlock[]>([])
  const [mfdLatexHints, setMfdLatexHints] = useState<
    { box: Box; latex: string }[]
  >([])
  const addMfdTypeRef = useRef(addMfdType)
  addMfdTypeRef.current = addMfdType
  const naturalRef = useRef(natural)
  naturalRef.current = natural
  const analysisLoadGenRef = useRef(0)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
        return
      e.preventDefault()
      setPeekOverlays(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') setPeekOverlays(false)
    }
    const onBlur = () => setPeekOverlays(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  const [layoutActive, setLayoutActive] = useState<LayoutDragState | null>(null)
  const [mfdActive, setMfdActive] = useState<MfdDragState | null>(null)
  const layoutDraftRef = useRef<Box | null>(null)
  const mfdDraftRef = useRef<Box | null>(null)
  const layoutRegionsRef = useRef(layoutRegions)
  layoutRegionsRef.current = layoutRegions
  const [draw, setDraw] = useState<{
    x0: number
    y0: number
    x1: number
    y1: number
  } | null>(null)
  const [active, setActive] = useState<DragState | null>(null)
  const draftRef = useRef<Box | null>(null)
  const [draftTick, setDraftTick] = useState(0)
  const [analysisTitles, setAnalysisTitles] = useState<Box[]>([])
  const [analysisInstructions, setAnalysisInstructions] = useState<
    { box: Box; text: string }[]
  >([])

  const disp = {
    w: baseDisp.w * zoom,
    h: baseDisp.h * zoom,
  }
  const scaleX = disp.w / Math.max(natural.w, 1)
  const scaleY = disp.h / Math.max(natural.h, 1)

  const effectiveMfdRegions = useMemo(() => {
    if (!mfdActive || !mfdDraftRef.current) return mfdRegions
    return mfdRegions.map((m, i) =>
      i === mfdActive.mfdIndex
        ? { ...m, box: [...mfdDraftRef.current!] as Box }
        : m,
    )
  }, [mfdRegions, mfdActive, draftTick])

  const liveComposeSplice = useMemo(
    () =>
      computeLiveSpliceDebug(
        pageVisionBlocks,
        layoutRegions,
        effectiveMfdRegions,
        mfdLatexHints,
      ),
    [pageVisionBlocks, layoutRegions, effectiveMfdRegions, mfdLatexHints],
  )

  const pageBgUrl = imageSrc && !imgFailed ? cssBackgroundUrl(imageSrc) : undefined

  // Load layout/MFD + debug vision boxes from published analysis.
  useEffect(() => {
    dismissedInstrRef.current = new Set()
    dismissedFormulaRef.current = new Set()
    if (!analysisSlug) {
      setAnalysisTitles([])
      setAnalysisInstructions([])
      if (!trainingSession) {
        setLayoutRegions([])
        setMfdRegions([])
        setPageVisionBlocks([])
        setMfdLatexHints([])
      }
      return
    }
    const loadGen = ++analysisLoadGenRef.current
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(
          `/api/page-ocr/analysis/${encodeURIComponent(analysisSlug)}/${page}`,
        )
        const ct = res.headers.get('content-type') || ''
        if (!res.ok || !ct.includes('json')) return
        const data = (await res.json()) as {
          ok?: boolean
          blocks?: { kind?: string; box?: number[]; text?: string }[]
          titles?: { kind?: string; box?: number[]; text?: string }[]
          layout?: { kind?: string; box?: number[]; score?: number }[]
          layout_corrected?: { kind?: string; box?: number[]; score?: number }[]
          vision_text?: { text?: string; box?: number[]; score?: number }[]
          mfd_vision_geometry?: { type?: string; box?: number[] }[]
          compose?: {
            vision_stem?: { text?: string; box?: number[]; score?: number }[]
            vision_raw?: { text?: string; box?: number[]; score?: number }[]
            vision_kept?: { text?: string; box?: number[]; score?: number }[]
            mfd_geometry?: number[][]
            splice?: {
              vision_dropped?: { text?: string; box?: number[]; score?: number }[]
              vision_keep?: { text?: string; box?: number[]; score?: number }[]
              vision_prose?: { text?: string; box?: number[]; score?: number }[]
              mfd_geometry?: number[][]
              mfd_detection?: { box?: number[]; latex?: string }[]
            }
            regions?: {
              kind?: string
              vision?: { text?: string; box?: number[]; score?: number }[]
              splice?: {
                vision_dropped?: { text?: string; box?: number[]; score?: number }[]
                vision_keep?: { text?: string; box?: number[]; score?: number }[]
                vision_prose?: { text?: string; box?: number[]; score?: number }[]
                mfd_geometry?: number[][]
                mfd_detection?: { box?: number[]; latex?: string }[]
              }
            }[]
          }
          formulas?: { box?: number[]; text?: string }[]
        }
        if (cancelled || loadGen !== analysisLoadGenRef.current || !data.ok) return
        // Seed once from analysis. Never overwrite after the user edits kinds/boxes
        // (late /analysis responses were resetting region type before Re-run).
        if (!trainingSession && !layoutDirtyRef.current) {
          setLayoutRegions(
            resolveLayoutFromAnalysis(data, initialLayout),
          )
          const seedMfd = resolveMfdSeed(
            data as {
              mfd_corrected?: { type?: string; box?: number[]; score?: number }[]
              mfd?: { type?: string; box?: number[]; score?: number }[]
              formulas?: { box?: number[]; score?: number }[]
            },
            initialMfd,
          )
          setMfdRegions(seedMfd)
        }
        const visionRaw = extractVisionFromAnalysis(data)
        setPageVisionBlocks(visionRaw)
        setMfdLatexHints(extractMfdLatexHints(data))
        const seenT = new Set<string>()
        const seenI = new Set<string>()
        const titles: Box[] = []
        const instructions: { box: Box; text: string }[] = []
        const pushBox = (
          box: number[] | undefined,
          into: Box[],
          seen: Set<string>,
        ) => {
          if (!box || box.length !== 4) return
          const key = box.map((n) => Math.round(n)).join(',')
          if (seen.has(key)) return
          seen.add(key)
          into.push([box[0]!, box[1]!, box[2]!, box[3]!])
        }
        const pushInstr = (box: number[] | undefined, text: string) => {
          if (!box || box.length !== 4) return
          const key = box.map((n) => Math.round(n)).join(',')
          if (seenI.has(key)) return
          seenI.add(key)
          instructions.push({
            box: [box[0]!, box[1]!, box[2]!, box[3]!,],
            text: text.trim(),
          })
        }
        for (const b of data.titles || []) pushBox(b.box, titles, seenT)
        for (const b of data.blocks || []) {
          if (b.kind === 'title') pushBox(b.box, titles, seenT)
          if (b.kind === 'instruction') pushInstr(b.box, b.text || '')
        }
        instructions.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
        setAnalysisTitles(titles)
        setAnalysisInstructions(instructions)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [analysisSlug, page, trainingSession])

  useEffect(() => {
    setSpliceOverlay(false)
  }, [analysisSlug, page])

  // Re-seed layout/MFD only when the training page identity changes
  // (not on every parent re-render / status update).
  useEffect(() => {
    layoutDirtyRef.current = !!(initialLayout?.length || initialMfd?.length)
    if (initialLayout?.length) {
      setLayoutRegions(initialLayout)
    }
    if (initialMfd) {
      setMfdRegions(initialMfd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed on page/slug only
  }, [page, analysisSlug, trainingSession])

  function markLayoutDirty() {
    layoutDirtyRef.current = true
  }

  function setLayoutRegionsDirty(
    update: LayoutRegionEdit[] | ((prev: LayoutRegionEdit[]) => LayoutRegionEdit[]),
  ) {
    markLayoutDirty()
    setLayoutRegions(update)
  }

  function setMfdRegionsDirty(
    update: MfdRegionEdit[] | ((prev: MfdRegionEdit[]) => MfdRegionEdit[]),
  ) {
    markLayoutDirty()
    setMfdRegions(update)
  }

  // One-shot: strip any leftover formula @parts from this page's markdown
  useEffect(() => {
    const cleaned = stripFormulaPartMarkers(markdownRef.current)
    if (cleaned !== markdownRef.current) {
      markdownRef.current = cleaned
      onMarkdownChange(cleaned)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when page/slug changes
  }, [page, imageSrc, analysisSlug])

  const seedW = imageSize?.w && imageSize.w > 1 ? imageSize.w : 0
  const seedH = imageSize?.h && imageSize.h > 1 ? imageSize.h : 0

  const applyImageSize = useCallback((nw: number, nh: number) => {
    if (nw < 2 || nh < 2) return
    setNatural({ w: nw, h: nh })
    naturalRef.current = { w: nw, h: nh }
    const parent = wrapRef.current
    const cw = parent?.clientWidth ?? 0
    // Modal/flex stage often reports 0 on the first tick — don't shrink to a
    // postage stamp (that blanks the page behind layout/MFD overlays).
    const maxW =
      cw >= 64 ? cw : Math.max(seedW > 1 ? Math.min(900, seedW) : 900, 320)
    const fit = Math.min(1, maxW / nw)
    const next = { w: nw * fit, h: nh * fit }
    setBaseDisp((prev) => {
      if (prev.w > 120 && next.w < 48) return prev
      if (next.w < 120) {
        const w = Math.max(next.w, 320)
        return { w, h: nh * (w / nw) }
      }
      return next
    })
    setImgFailed(false)
  }, [seedW])

  // Cached images often skip onLoad — measure via complete + imageSize seed.
  // useLayoutEffect so we size before paint (avoids blank 1×1 flash on page change).
  useLayoutEffect(() => {
    setImgFailed(false)
    setZoom(1)
    if (seedW > 1 && seedH > 1) {
      applyImageSize(seedW, seedH)
    }
    const img = imgRef.current
    if (!img) return
    const apply = () => applyImageSize(img.naturalWidth, img.naturalHeight)
    const onErr = () => setImgFailed(true)
    if (img.complete && img.naturalWidth > 1) {
      apply()
    } else {
      img.addEventListener('load', apply)
    }
    img.addEventListener('error', onErr)
    // Retry once after layout — stage width is often 0 on the first tick
    const t = window.setTimeout(() => {
      const n = naturalRef.current
      if (n.w > 1 && n.h > 1) applyImageSize(n.w, n.h)
      else if (img.naturalWidth > 1) apply()
    }, 50)
    const t2 = window.setTimeout(() => {
      const n = naturalRef.current
      if (n.w > 1 && n.h > 1) applyImageSize(n.w, n.h)
    }, 250)
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(t2)
      img.removeEventListener('load', apply)
      img.removeEventListener('error', onErr)
    }
  }, [imageSrc, seedW, seedH, applyImageSize])

  // Re-fit when the stage actually gets a non-zero width
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w < 64) return
      const n = naturalRef.current
      if (n.w > 1 && n.h > 1) applyImageSize(n.w, n.h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [applyImageSize])

  const refitBase = useCallback(() => {
    const n = naturalRef.current
    if (n.w <= 1) return
    applyImageSize(n.w, n.h)
  }, [applyImageSize])

  useEffect(() => {
    refitBase()
    window.addEventListener('resize', refitBase)
    return () => window.removeEventListener('resize', refitBase)
  }, [refitBase, imageSrc])

  useEffect(() => {
    if (!active) return
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - active.startX) / scaleX
      const dy = (e.clientY - active.startY) / scaleY
      let [x0, y0, x1, y1] = active.startBox
      const h = active.handle
      if (h === 'move') {
        const w = x1 - x0
        const ht = y1 - y0
        x0 += dx
        y0 += dy
        x1 = x0 + w
        y1 = y0 + ht
      } else {
        if (h.includes('w')) x0 += dx
        if (h.includes('e')) x1 += dx
        if (h.includes('n')) y0 += dy
        if (h.includes('s')) y1 += dy
      }
      if (x1 - x0 < 16) x1 = x0 + 16
      if (y1 - y0 < 16) y1 = y0 + 16
      x0 = Math.max(0, Math.min(x0, natural.w - 16))
      y0 = Math.max(0, Math.min(y0, natural.h - 16))
      x1 = Math.max(x0 + 16, Math.min(x1, natural.w))
      y1 = Math.max(y0 + 16, Math.min(y1, natural.h))
      let nextBox: Box = [x0, y0, x1, y1]
      if (active.kind === 'figure') {
        const reg = regionsRef.current.find(
          (r) => r.figure && r.figure.index === active.partIndex,
        )
        nextBox = figureBoxAvoidingQuestion(nextBox, reg?.question.box)
        nextBox = figureBoxAvoidingOptions(nextBox, reg?.options?.box)
      }
      draftRef.current = nextBox
      setDraftTick((n) => n + 1)
    }
    const onUp = () => {
      let box = draftRef.current
      const act = active
      draftRef.current = null
      setActive(null)
      setDraftTick((n) => n + 1)
      if (!act || !box) return
      if (act.kind === 'figure') {
        const reg = regionsRef.current.find(
          (r) => r.figure && r.figure.index === act.partIndex,
        )
        box = figureBoxAvoidingQuestion(box, reg?.question.box)
        box = figureBoxAvoidingOptions(box, reg?.options?.box)
      }
      if (act.partIndex < 0) {
        // Display-only stem above orphan options — persist as a real @part
        if (isNumberKind(act.kind)) {
          const next = insertPartComment(
            markdownRef.current,
            page,
            'number',
            box,
            imageSrc,
          )
          if (next !== markdownRef.current) {
            markdownRef.current = next
            onMarkdownChange(next)
          }
        }
        return
      }
      let next = updatePartBoxAt(markdownRef.current, act.partIndex, box)
      // Resize/move only updates the box — never re-OCR existing content
      markdownRef.current = next
      if (next !== markdown) onMarkdownChange(next)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [
    active,
    scaleX,
    scaleY,
    natural,
    onMarkdownChange,
    page,
    imageSrc,
    markdown,
  ])

  useEffect(() => {
    if (!layoutActive) return
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - layoutActive.startX) / scaleX
      const dy = (e.clientY - layoutActive.startY) / scaleY
      let [x0, y0, x1, y1] = layoutActive.startBox
      const h = layoutActive.handle
      if (h === 'move') {
        const w = x1 - x0
        const ht = y1 - y0
        x0 += dx
        y0 += dy
        x1 = x0 + w
        y1 = y0 + ht
      } else {
        if (h.includes('w')) x0 += dx
        if (h.includes('e')) x1 += dx
        if (h.includes('n')) y0 += dy
        if (h.includes('s')) y1 += dy
      }
      if (x1 - x0 < 16) x1 = x0 + 16
      if (y1 - y0 < 16) y1 = y0 + 16
      x0 = Math.max(0, Math.min(x0, natural.w - 16))
      y0 = Math.max(0, Math.min(y0, natural.h - 16))
      x1 = Math.max(x0 + 16, Math.min(x1, natural.w))
      y1 = Math.max(y0 + 16, Math.min(y1, natural.h))
      layoutDraftRef.current = [x0, y0, x1, y1]
      setDraftTick((n) => n + 1)
    }
    const onUp = () => {
      const box = layoutDraftRef.current
      const act = layoutActive
      layoutDraftRef.current = null
      setLayoutActive(null)
      setDraftTick((n) => n + 1)
      if (!act || !box) return
      setLayoutRegionsDirty((prev) =>
        prev.map((r, i) => (i === act.layoutIndex ? { ...r, box } : r)),
      )
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [layoutActive, scaleX, scaleY, natural])

  useEffect(() => {
    if (!mfdActive) return
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - mfdActive.startX) / scaleX
      const dy = (e.clientY - mfdActive.startY) / scaleY
      let [x0, y0, x1, y1] = mfdActive.startBox
      const h = mfdActive.handle
      if (h === 'move') {
        const w = x1 - x0
        const ht = y1 - y0
        x0 += dx
        y0 += dy
        x1 = x0 + w
        y1 = y0 + ht
      } else {
        if (h.includes('w')) x0 += dx
        if (h.includes('e')) x1 += dx
        if (h.includes('n')) y0 += dy
        if (h.includes('s')) y1 += dy
      }
      if (x1 - x0 < 12) x1 = x0 + 12
      if (y1 - y0 < 12) y1 = y0 + 12
      x0 = Math.max(0, Math.min(x0, natural.w - 12))
      y0 = Math.max(0, Math.min(y0, natural.h - 12))
      x1 = Math.max(x0 + 12, Math.min(x1, natural.w))
      y1 = Math.max(y0 + 12, Math.min(y1, natural.h))
      mfdDraftRef.current = [x0, y0, x1, y1]
      setDraftTick((n) => n + 1)
    }
    const onUp = () => {
      const box = mfdDraftRef.current
      const act = mfdActive
      mfdDraftRef.current = null
      setMfdActive(null)
      setDraftTick((n) => n + 1)
      if (!act || !box) return
      setMfdRegionsDirty((prev) =>
        prev.map((r, i) => (i === act.mfdIndex ? { ...r, box } : r)),
      )
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [mfdActive, scaleX, scaleY, natural])

  function clientToImg(e: { clientX: number; clientY: number }): [number, number] {
    const stage = wrapRef.current?.querySelector('.crop-overlay') as HTMLElement | null
    if (!stage) return [0, 0]
    const r = stage.getBoundingClientRect()
    const x = (e.clientX - r.left) / scaleX
    const y = (e.clientY - r.top) / scaleY
    return [
      Math.max(0, Math.min(natural.w, x)),
      Math.max(0, Math.min(natural.h, y)),
    ]
  }

  function onStagePointerDown(e: ReactPointerEvent) {
    if (addMfdType) {
      // Don't start a new draw when grabbing an existing box handle/body
      if (
        (e.target as HTMLElement).closest(
          '.mfd-box, .layout-box .crop-handle, .layout-box .crop-delete',
        )
      ) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const typ = addMfdTypeRef.current
      if (!typ) return
      const [x, y] = clientToImg(e)
      setDraw({ x0: x, y0: y, x1: x, y1: y })
      const onMove = (ev: PointerEvent) => {
        const [x1, y1] = clientToImg(ev)
        setDraw((d) => (d ? { ...d, x1, y1 } : d))
      }
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        const [x1, y1] = clientToImg(ev)
        setDraw(null)
        const x0 = Math.min(x, x1)
        const y0 = Math.min(y, y1)
        const x2 = Math.max(x, x1)
        const y2 = Math.max(y, y1)
        if (x2 - x0 < 8 || y2 - y0 < 8) {
          return
        }
        // Keep add mode on — draw more boxes without re-clicking the toolbar
        setMfdRegionsDirty((prev) => [
          ...prev,
          { type: typ, box: [x0, y0, x2, y2], score: 1 },
        ])
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    if (!addLayoutKind) return
    if ((e.target as HTMLElement).closest('.layout-box, .mfd-box')) return
    e.preventDefault()
    const [x, y] = clientToImg(e)
    setDraw({ x0: x, y0: y, x1: x, y1: y })
    const onMove = (ev: PointerEvent) => {
      const [x1, y1] = clientToImg(ev)
      setDraw((d) => (d ? { ...d, x1, y1 } : d))
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const [x1, y1] = clientToImg(ev)
      setDraw(null)
      const x0 = Math.min(x, x1)
      const y0 = Math.min(y, y1)
      const x2 = Math.max(x, x1)
      const y2 = Math.max(y, y1)
      if (x2 - x0 < 12 || y2 - y0 < 12) {
        setAddLayoutKind(null)
        setAddMfdType('embedding')
        return
      }
      const kind = addLayoutKind
      setAddLayoutKind(null)
      setAddMfdType('embedding')
      setLayoutRegionsDirty((prev) => [
        ...prev,
        { kind, box: [x0, y0, x2, y2], score: 1 },
      ])
      onStatus?.(
        onConfirmContinue
          ? `Added layout ${kind} — Confirm & continue when done`
          : `Added layout ${kind} — Save layout or Re-run OCR when done`,
      )
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function deletePart(part: DocPart) {
    if (isListNoteKind(part.kind)) {
      dismissedInstrRef.current.add(boxKey(part.box))
    }
    if (part.kind === 'formula') {
      dismissedFormulaRef.current.add(boxKey(part.box))
    }
    const next = removePartSection(markdownRef.current, part)
    if (next !== markdownRef.current) {
      markdownRef.current = next
      onMarkdownChange(next)
    }
  }

  function deleteLayoutRegion(index: number) {
    setLayoutRegionsDirty((prev) => prev.filter((_, i) => i !== index))
  }

  function deleteMfdRegion(index: number) {
    setMfdRegionsDirty((prev) => prev.filter((_, i) => i !== index))
  }

  const LAYOUT_KIND_CYCLE: LayoutKind[] = [
    'title',
    'text',
    'figure',
    'table',
    'formula',
    'ignored',
  ]

  function setLayoutRegionKind(index: number, kind: LayoutKind) {
    setLayoutRegionsDirty((prev) =>
      prev.map((r, i) => (i === index ? { ...r, kind, score: 1 } : r)),
    )
    onStatus?.(
      `Layout region → ${kind} — Re-run OCR / Confirm to apply`,
    )
  }

  function cycleLayoutRegionKind(index: number) {
    const cur = layoutRegionsRef.current[index]
    if (!cur) return
    const at = LAYOUT_KIND_CYCLE.indexOf(cur.kind)
    const next = LAYOUT_KIND_CYCLE[(at + 1) % LAYOUT_KIND_CYCLE.length]!
    setLayoutRegionKind(index, next)
  }

  const renderMfdBox = (reg: MfdRegionEdit, index: number) => {
    const live =
      mfdActive && mfdActive.mfdIndex === index && mfdDraftRef.current
        ? mfdDraftRef.current
        : reg.box
    const [x0, y0, x1, y1] = live
    const style: CSSProperties = {
      left: x0 * scaleX,
      top: y0 * scaleY,
      width: (x1 - x0) * scaleX,
      height: (y1 - y0) * scaleY,
      borderColor: MFD_COLOR,
      zIndex: 3,
    }
    const startDrag = (handle: Handle) => (e: ReactPointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      mfdDraftRef.current = [...reg.box] as Box
      setMfdActive({
        mfdIndex: index,
        handle,
        startBox: [...reg.box] as Box,
        startX: e.clientX,
        startY: e.clientY,
      })
    }
    return (
      <div
        key={`mfd-${index}`}
        className="mfd-box"
        style={style}
        onPointerDown={startDrag('move')}
      >
        <span className="crop-label">mfd:{reg.type}</span>
        <button
          type="button"
          className="crop-delete"
          title={`Delete MFD ${reg.type}`}
          aria-label={`Delete MFD ${reg.type}`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            deleteMfdRegion(index)
          }}
        >
          ×
        </button>
        {(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as Handle[]).map((h) => (
          <i
            key={h}
            className={`crop-handle crop-handle-${h}`}
            onPointerDown={startDrag(h)}
          />
        ))}
      </div>
    )
  }

  const renderVisionKeepBox = (blk: VisionTextBlock, index: number) => {
    const [x0, y0, x1, y1] = blk.box
    const style: CSSProperties = {
      left: x0 * scaleX,
      top: y0 * scaleY,
      width: (x1 - x0) * scaleX,
      height: (y1 - y0) * scaleY,
      zIndex: 5,
    }
    return (
      <div
        key={`vision-keep-${index}-${boxKey(blk.box)}`}
        className="vision-keep-box"
        style={style}
        title={`keep: ${blk.text}`}
      >
        <span className="crop-label">keep</span>
      </div>
    )
  }

  const renderSpliceHoleBox = (geom: MfdVisionGeom, index: number) => {
    const [x0, y0, x1, y1] = geom.box
    const style: CSSProperties = {
      left: x0 * scaleX,
      top: y0 * scaleY,
      width: (x1 - x0) * scaleX,
      height: (y1 - y0) * scaleY,
      zIndex: 4,
    }
    const title = geom.latex
      ? `hole/MFD · ${geom.latex}`
      : 'hole/MFD (Vision dropped here)'
    return (
      <div
        key={`splice-hole-${index}-${boxKey(geom.box)}`}
        className="splice-hole-box"
        style={style}
        title={title}
      >
        <span className="crop-label">hole</span>
      </div>
    )
  }

  const renderLayoutBox = (reg: LayoutRegionEdit, index: number) => {
    const live =
      layoutActive && layoutActive.layoutIndex === index && layoutDraftRef.current
        ? layoutDraftRef.current
        : reg.box
    const [x0, y0, x1, y1] = live
    const style: CSSProperties = {
      left: x0 * scaleX,
      top: y0 * scaleY,
      width: (x1 - x0) * scaleX,
      height: (y1 - y0) * scaleY,
      borderColor: LAYOUT_KIND_COLOR[reg.kind],
      zIndex: 1,
    }
    const startDrag = (handle: Handle) => (e: ReactPointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      // With +title/+text/… active, click body converts kind (no drag)
      if (handle === 'move' && addLayoutKind && addLayoutKind !== reg.kind) {
        setLayoutRegionKind(index, addLayoutKind)
        setAddLayoutKind(null)
        setAddMfdType('embedding')
        return
      }
      layoutDraftRef.current = [...reg.box] as Box
      setLayoutActive({
        layoutIndex: index,
        kind: reg.kind,
        handle,
        startBox: [...reg.box] as Box,
        startX: e.clientX,
        startY: e.clientY,
      })
    }
    return (
      <div
        key={`layout-${index}-${reg.kind}`}
        className={`layout-box layout-${reg.kind}`}
        style={style}
        onPointerDown={startDrag('move')}
      >
        <button
          type="button"
          className="crop-label"
          title={`Click to cycle type (now ${reg.kind})`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            cycleLayoutRegionKind(index)
          }}
        >
          {reg.kind}
        </button>
        <button
          type="button"
          className="crop-delete"
          title={`Delete ${reg.kind}`}
          aria-label={`Delete ${reg.kind}`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            deleteLayoutRegion(index)
          }}
        >
          ×
        </button>
        {(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as Handle[]).map((h) => (
          <i
            key={h}
            className={`crop-handle crop-handle-${h}`}
            onPointerDown={startDrag(h)}
          />
        ))}
      </div>
    )
  }

  const renderBox = (part: DocPart, kind: CropKind) => {
    const live =
      active && active.partIndex === part.index && draftRef.current
        ? draftRef.current
        : part.box
    const [x0, y0, x1, y1] = live
    const style: CSSProperties = {
      left: x0 * scaleX,
      top: y0 * scaleY,
      width: (x1 - x0) * scaleX,
      height: (y1 - y0) * scaleY,
      borderColor: part.color || KIND_COLOR[kind],
    }
    const start = (handle: Handle) => (e: ReactPointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      draftRef.current = [...part.box] as Box
      setActive({
        partIndex: part.index,
        kind,
        handle,
        startBox: [...part.box] as Box,
        startX: e.clientX,
        startY: e.clientY,
      })
    }
    return (
      <div
        key={`${part.index}-${kind}`}
        className={`crop-box crop-${canonKind(kind)}`}
        style={style}
        onPointerDown={start('move')}
      >
        <span className="crop-label">{kind}</span>
        <button
          type="button"
          className="crop-delete"
          title={`Delete ${kind}`}
          aria-label={`Delete ${kind}`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            deletePart(part)
          }}
        >
          ×
        </button>
        {(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as Handle[]).map((h) => (
          <i
            key={h}
            className={`crop-handle crop-handle-${h}`}
            onPointerDown={start(h)}
          />
        ))}
      </div>
    )
  }

  const drawStyle: CSSProperties | undefined = draw
    ? {
        left: Math.min(draw.x0, draw.x1) * scaleX,
        top: Math.min(draw.y0, draw.y1) * scaleY,
        width: Math.abs(draw.x1 - draw.x0) * scaleX,
        height: Math.abs(draw.y1 - draw.y0) * scaleY,
        borderColor: addMfdType
          ? MFD_COLOR
          : addLayoutKind
            ? LAYOUT_KIND_COLOR[addLayoutKind]
            : '#000',
      }
    : undefined

  return (
    <div className={`crop-editor${fillViewport ? ' crop-editor-fill' : ''}`}>
      <div className="crop-editor-toolbar">
        <div className="crop-toolbar-left">
          {onClose ? (
            <button type="button" className="crop-close" onClick={onClose}>
              Close
            </button>
          ) : null}
          <span className="crop-page-label">Page {page}</span>
          <button
            type="button"
            title="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
          >
            −
          </button>
          <span className="crop-zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            title="Zoom in"
            onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100))}
          >
            +
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            Reset
          </button>
          <span className="crop-toolbar-sep">|</span>
          <button
            type="button"
            className={spliceOverlay ? 'is-active' : ''}
            title="Path A splice: cyan Keep (Vision outside MFD); orange hole = MFD"
            onClick={() => setSpliceOverlay((on) => !on)}
          >
            Splice
          </button>
          <span className="crop-toolbar-sep">|</span>
          {(
            [
              'title',
              'text',
              'figure',
              'table',
              'formula',
              'ignored',
            ] as LayoutKind[]
          ).map((k) => (
            <button
              key={k}
              type="button"
              className={addLayoutKind === k ? 'is-active' : ''}
              title={`Draw ${k} layout region`}
              onClick={() => {
                setAddLayoutKind((cur) => {
                  if (cur === k) {
                    setAddMfdType('embedding')
                    return null
                  }
                  setAddMfdType(null)
                  return k
                })
              }}
            >
              + {k}
            </button>
          ))}
          <span className="crop-toolbar-sep">|</span>
          {(['embedding', 'isolated'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={addMfdType === t ? 'is-active' : ''}
              title={`Draw MFD ${t} formula box`}
              onClick={() => {
                setAddLayoutKind(null)
                setAddMfdType((cur) => (cur === t ? null : t))
              }}
            >
              + mfd:{t}
            </button>
          ))}
          <button
            type="button"
            className={peekOverlays ? 'is-active' : ''}
            title="Hold to see page through overlays (or hold Space)"
            onPointerDown={(e) => {
              e.preventDefault()
              setPeekOverlays(true)
            }}
            onPointerUp={() => setPeekOverlays(false)}
            onPointerLeave={() => setPeekOverlays(false)}
            onClick={(e) => e.preventDefault()}
          >
            Peek
          </button>
        </div>
        <div className="crop-toolbar-right">
          {onConfirmContinue ? (
            <button
              type="button"
              disabled={layoutBusy}
              className="crop-confirm-continue"
              onClick={() => void onConfirmContinue(layoutRegions, mfdRegions)}
            >
              {layoutBusy ? 'Continuing…' : 'Confirm & continue OCR'}
            </button>
          ) : null}
          {onSaveLayout && !onConfirmContinue ? (
            <button
              type="button"
              disabled={layoutBusy || layoutRegions.length === 0}
              onClick={() => void onSaveLayout(layoutRegions)}
            >
              {layoutBusy ? 'Saving…' : 'Save layout'}
            </button>
          ) : null}
          {onRerunWithLayout && !onConfirmContinue ? (
            <button
              type="button"
              disabled={layoutBusy || layoutRegions.length === 0}
              title="Full pipeline with edited layout + MFD"
              onClick={() => void onRerunWithLayout(layoutRegions, mfdRegions)}
            >
              {layoutBusy ? 'Running…' : 'Re-run OCR'}
            </button>
          ) : null}
          {onTrainLayout ? (
            <button
              type="button"
              disabled={layoutBusy}
              title={
                layoutTrainPairs
                  ? `Manual layout train · ${layoutTrainPairs} page(s) saved`
                  : 'Manual layout train (saves labels on Confirm; train when you ask)'
              }
              onClick={() => void onTrainLayout()}
            >
              Train YOLO
            </button>
          ) : null}
        </div>
      </div>
      {addLayoutKind ? (
        <p className="crop-draw-hint">
          Draw a <strong>{addLayoutKind}</strong> layout region, then release.
        </p>
      ) : null}
      {addMfdType ? (
        <p className="crop-draw-hint">
          Draw <strong>MFD {addMfdType}</strong> boxes (stays on). Drag box edges to resize — click + mfd:{addMfdType} again to stop.
        </p>
      ) : null}
      <p className="crop-layout-hint">
        Edit layout + MFD boxes. Click Splice for Path A Keep/hole overlays.
        {onConfirmContinue
          ? ' → Confirm & continue OCR (saves layout+MFD labels; no auto-retrain).'
          : ' → Save layout, or Re-run OCR (uses edited layout + MFD). Flip Production toggle later to skip edit.'}
        {' '}Hold <kbd>Space</kbd> or Peek to see through overlays.
      </p>
      {spliceOverlay ? (
        <p className="crop-draw-hint">
          Splice: dashed cyan = Keep outside MFD; orange = hole. (
          {liveComposeSplice.visionKeep.length} keep /{' '}
          {liveComposeSplice.mfdHoles.length} hole)
          {pageVisionBlocks.length === 0
            ? ' No Vision loaded — check analysis vision_text.'
            : null}
        </p>
      ) : null}
      <div
        className={`crop-editor-stage${addLayoutKind || addMfdType ? ' is-drawing' : ''}${addMfdType ? ' is-drawing-mfd' : ''}${peekOverlays ? ' is-peek' : ''}${spliceOverlay ? ' is-compose-debug' : ''}${fillViewport ? ' crop-stage-fill' : ''}`}
        ref={wrapRef}
      >
        <div
          className="crop-zoom-inner"
          style={{
            width: disp.w,
            height: disp.h,
            minWidth: disp.w,
            minHeight: disp.h,
            backgroundImage: pageBgUrl,
            backgroundSize: '100% 100%',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: '0 0',
          }}
          onPointerDown={onStagePointerDown}
        >
          {pageBgUrl ? (
            <div
              className="crop-page-bg"
              aria-hidden
              style={{
                width: disp.w,
                height: disp.h,
                backgroundImage: pageBgUrl,
              }}
            />
          ) : null}
          <img
            key={imageSrc}
            ref={imgRef}
            className="crop-base-img"
            src={imageSrc}
            alt={`Page ${page}`}
            draggable={false}
            style={{
              width: disp.w,
              height: disp.h,
              opacity: imgFailed ? 0 : 1,
            }}
            onLoad={(e) => {
              const img = e.currentTarget
              applyImageSize(img.naturalWidth, img.naturalHeight)
            }}
            onError={() => setImgFailed(true)}
          />
          {imgFailed ? (
            <p className="crop-draw-hint" style={{ position: 'absolute', zIndex: 2 }}>
              Page image failed to load: {imageSrc}
            </p>
          ) : null}
          <div className="crop-overlay" style={{ width: disp.w, height: disp.h }}>
            {layoutRegions.map((reg, i) => renderLayoutBox(reg, i))}
            {mfdRegions.map((reg, i) => renderMfdBox(reg, i))}
            {/* Splice: hole / Keep only (no raw Vision text overlay) */}
            {spliceOverlay
              ? liveComposeSplice.mfdHoles.map((geom, i) =>
                  renderSpliceHoleBox(geom, i),
                )
              : null}
            {spliceOverlay
              ? liveComposeSplice.visionKeep.map((blk, i) =>
                  renderVisionKeepBox(blk, i),
                )
              : null}
            {draw && drawStyle ? (
              <div className="crop-box crop-drawing" style={drawStyle} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export function regionsPayload(regions: CropRegion[]) {
  return regions
    .filter((r) => !r.qid.startsWith('orphan-fig-'))
    .map((r) => ({
      qid: r.qid,
      question: r.question.box,
      number: r.question.box,
      options: r.options?.box ?? null,
      option: r.options?.box ?? null,
      figure: r.figure?.box ?? null,
    }))
}
