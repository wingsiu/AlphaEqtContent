import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

type SaveBody = {
  slug: string
  files: { name: string; base64: string }[]
}

/**
 * Dev/API helper: POST /api/import-media { slug, files:[{name,base64}] }
 * writes to public/imports/<slug>/ so Markdown can use /imports/<slug>/img-001.png
 */
export function importMediaPlugin(): Plugin {
  return {
    name: 'alphaeqt-import-media',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'POST' || req.url !== '/api/import-media') {
          next()
          return
        }
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SaveBody
          const slug = (body.slug || 'import')
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'import'
          const dir = path.resolve(process.cwd(), 'public', 'imports', slug)
          fs.mkdirSync(dir, { recursive: true })
          const saved: string[] = []
          for (const file of body.files || []) {
            const name = path.basename(file.name).replace(/[^a-zA-Z0-9._-]+/g, '-')
            const buf = Buffer.from(file.base64, 'base64')
            fs.writeFileSync(path.join(dir, name), buf)
            saved.push(`/imports/${slug}/${name}`)
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, slug, paths: saved }))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      })
    },
  }
}
