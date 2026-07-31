import { useEffect, useMemo, useRef, useState } from 'react'

export type DocPart = {
  kind: string
  id: string
  page: number
  box: [number, number, number, number]
  src: string
  color: string
  imgW?: number
  imgH?: number
  index: number
}

const PART_RE =
  /<!--\s*@part\s+kind=(\S+)\s+id=(\S+)\s+page=(\d+)\s+box=([\d.,-]+)\s+src="([^"]*)"\s+color=(#[0-9a-fA-F]+)(?:\s+imgsz=(\d+)x(\d+))?\s*-->/g

export function parseDocParts(md: string): DocPart[] {
  const parts: DocPart[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(PART_RE.source, 'g')
  while ((m = re.exec(md)) !== null) {
    const nums = m[4].split(',').map(Number)
    if (nums.length !== 4 || nums.some((n) => Number.isNaN(n))) continue
    parts.push({
      kind: m[1],
      id: m[2],
      page: Number(m[3]),
      box: [nums[0], nums[1], nums[2], nums[3]],
      src: m[5],
      color: m[6],
      imgW: m[7] ? Number(m[7]) : undefined,
      imgH: m[8] ? Number(m[8]) : undefined,
      index: m.index,
    })
  }
  return parts
}

export function partAtCursor(parts: DocPart[], cursor: number): DocPart | null {
  if (parts.length === 0) return null
  let best: DocPart | null = null
  for (const p of parts) {
    if (p.index <= cursor) best = p
    else break
  }
  return best ?? parts[0]
}

const KIND_LABEL: Record<string, string> = {
  title: 'Title',
  number: 'Number',
  question: 'Number',
  roman: 'Roman',
  normal: 'Normal',
  instruction: 'Normal',
  option: 'Option',
  options: 'Option',
  figure: 'Figure',
  table: 'Table',
  formula: 'Formula',
}

type Props = {
  markdown: string
  cursor: number
  /** Hide while full-window crop editor is open */
  hidden?: boolean
}

/** Part crop preview pinned top-left. */
export function EditorPartZoom({ markdown, cursor, hidden }: Props) {
  const parts = useMemo(() => parseDocParts(markdown), [markdown])
  const active = useMemo(() => partAtCursor(parts, cursor), [parts, cursor])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [imgError, setImgError] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const activeKey = active
    ? `${active.page}:${active.kind}:${active.id}:${active.index}`
    : ''

  // Re-show when the caret moves to a different part
  useEffect(() => {
    setDismissed(false)
  }, [activeKey])

  useEffect(() => {
    setImgError(false)
    if (hidden || !active?.src || !canvasRef.current || dismissed) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      let [x0, y0, x1, y1] = active.box
      if (active.imgW && active.imgH && active.imgW > 0 && active.imgH > 0) {
        const sx = img.naturalWidth / active.imgW
        const sy = img.naturalHeight / active.imgH
        x0 *= sx
        x1 *= sx
        y0 *= sy
        y1 *= sy
      }
      x0 = Math.max(0, Math.min(x0, img.naturalWidth - 1))
      y0 = Math.max(0, Math.min(y0, img.naturalHeight - 1))
      x1 = Math.max(x0 + 1, Math.min(x1, img.naturalWidth))
      y1 = Math.max(y0 + 1, Math.min(y1, img.naturalHeight))

      const isFigure = active.kind === 'figure' || active.kind === 'table'
      const pad = isFigure ? 2 : 6
      const cx0 = Math.max(0, x0 - pad)
      const cy0 = Math.max(0, y0 - pad)
      const cw = Math.min(img.naturalWidth - cx0, x1 - x0 + pad * 2)
      const ch = Math.min(img.naturalHeight - cy0, y1 - y0 + pad * 2)

      const maxW = isFigure
        ? Math.min(280, window.innerWidth * 0.28)
        : Math.min(640, window.innerWidth * 0.5)
      const maxH = isFigure
        ? Math.min(160, window.innerHeight * 0.22)
        : Math.min(420, window.innerHeight * 0.5)
      const fit = Math.min(maxW / cw, maxH / ch)
      const scale = isFigure ? Math.min(1, fit) : fit

      const outW = Math.max(1, Math.round(cw * scale))
      const outH = Math.max(1, Math.round(ch * scale))
      canvas.width = outW
      canvas.height = outH
      canvas.style.width = `${outW}px`
      canvas.style.height = `${outH}px`

      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, outW, outH)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(img, cx0, cy0, cw, ch, 0, 0, outW, outH)

      const bx = (x0 - cx0) * scale
      const by = (y0 - cy0) * scale
      const bw = Math.max(2, (x1 - x0) * scale)
      const bh = Math.max(2, (y1 - y0) * scale)
      ctx.strokeStyle = active.color
      ctx.lineWidth = 2
      ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh)
      ctx.fillStyle = `${active.color}22`
      ctx.fillRect(bx, by, bw, bh)
    }
    img.onerror = () => setImgError(true)
    img.src = active.src
    return () => {
      cancelled = true
    }
  }, [active, dismissed, hidden])

  if (hidden || parts.length === 0 || !active) return null

  // Collapsed: keep a chip so dismiss is reversible
  if (dismissed) {
    return (
      <button
        type="button"
        className="part-zoom-show"
        title="Show part crop"
        onClick={() => setDismissed(false)}
      >
        Show crop · p.{active.page}
      </button>
    )
  }

  return (
    <div className="part-zoom-top" style={{ borderColor: active.color }}>
      <button
        type="button"
        className="part-zoom-dismiss"
        aria-label="Hide part crop"
        title="Hide"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
      <div className="part-zoom-meta">
        <span
          className="part-chip"
          style={{
            background: active.color,
            color: '#fff',
            borderColor: active.color,
          }}
        >
          {KIND_LABEL[active.kind] || active.kind}
          {active.id && active.id !== 'note' ? ` · ${active.id}` : ''}
        </span>
        <span className="part-zoom-page">p.{active.page}</span>
      </div>
      {imgError ? (
        <p className="part-zoom-miss">Source missing</p>
      ) : (
        <canvas ref={canvasRef} className="part-zoom-canvas" />
      )}
    </div>
  )
}
