import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const siteRoot = join(repoRoot, 'site')
const publicOrigin = 'https://ivyyang1999.github.io'
const publicBasePath = '/swob/'
const errors = []

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(absolute))
    else files.push(absolute)
  }
  return files
}

function report(source, message) {
  errors.push(`${relative(repoRoot, source)}: ${message}`)
}

function siteFileForUrl(value, source) {
  let url
  try {
    if (value.startsWith(`${publicOrigin}${publicBasePath}`)) {
      url = new URL(value)
      url.pathname = url.pathname.slice(publicBasePath.length - 1)
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
      return null
    } else {
      const sourceRoute = `/${relative(siteRoot, source).split(sep).join('/')}`
      url = new URL(value, `https://local.invalid${sourceRoute}`)
    }
  } catch {
    report(source, `invalid URL: ${value}`)
    return null
  }

  let decoded
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    report(source, `invalid URL encoding: ${value}`)
    return null
  }

  let target = join(siteRoot, decoded.replace(/^\/+/, ''))
  if (decoded.endsWith('/') || (existsSync(target) && statSync(target).isDirectory())) {
    target = join(target, 'index.html')
  }
  return { target, fragment: url.hash.slice(1), value }
}

function verifySiteReference(source, value) {
  if (!value || value.startsWith('data:') || value.startsWith('javascript:')) return
  const resolved = siteFileForUrl(value, source)
  if (!resolved) return
  if (!existsSync(resolved.target) || !statSync(resolved.target).isFile()) {
    report(source, `missing local target ${value} -> ${relative(siteRoot, resolved.target)}`)
    return
  }
  if (!resolved.fragment || extname(resolved.target).toLowerCase() !== '.html') return
  const fragment = decodeURIComponent(resolved.fragment)
  const targetHtml = readFileSync(resolved.target, 'utf8')
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`(?:id|name)=["']${escaped}["']`).test(targetHtml)) {
    report(source, `missing fragment #${fragment} in ${relative(siteRoot, resolved.target)}`)
  }
}

function verifyHtml(file) {
  const html = readFileSync(file, 'utf8')
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/g
  for (const match of html.matchAll(attributePattern)) verifySiteReference(file, match[1])

  const srcsetPattern = /\bsrcset=["']([^"']+)["']/g
  for (const match of html.matchAll(srcsetPattern)) {
    for (const candidate of match[1].split(',')) {
      verifySiteReference(file, candidate.trim().split(/\s+/)[0])
    }
  }

  if (!/<title>\s*[^<]+\s*<\/title>/i.test(html)) report(file, 'missing non-empty <title>')
  if (!/<meta\s+name=["']description["']\s+content=["'][^"']+["']/i.test(html)) {
    report(file, 'missing non-empty meta description')
  }
  if (!/<meta\s+name=["']viewport["']/i.test(html)) report(file, 'missing viewport metadata')
  if (!/<link\s+rel=["'][^"']*icon[^"']*["']/i.test(html)) report(file, 'missing favicon link')

  if (relative(siteRoot, file).split(sep).join('/').startsWith('docs/en/')) {
    if (!/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(html)) {
      report(file, 'reserved English placeholder must be noindex')
    }
  }
}

function verifyReadme(file) {
  const markdown = readFileSync(file, 'utf8')
  const targets = new Set()
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) targets.add(match[1])
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) targets.add(match[1])

  for (const raw of targets) {
    let value = raw.trim().replace(/^<|>$/g, '')
    if (/\s+["']/.test(value)) value = value.split(/\s+["']/)[0]
    if (!value || value.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) continue
    value = value.split('#')[0].split('?')[0]
    let decoded
    try {
      decoded = decodeURIComponent(value)
    } catch {
      report(file, `invalid URL encoding: ${value}`)
      continue
    }
    const target = resolve(dirname(file), decoded)
    if (!existsSync(target)) report(file, `missing repository target ${value}`)
  }
}

function routeForHtml(file) {
  let route = relative(siteRoot, file).split(sep).join('/')
  if (route === 'index.html') return `${publicOrigin}${publicBasePath}`
  if (route.endsWith('/index.html')) route = `${route.slice(0, -'index.html'.length)}`
  return `${publicOrigin}${publicBasePath}${route}`
}

function verifyLaunchMetadata(htmlFiles) {
  const homePages = [join(siteRoot, 'index.html'), join(siteRoot, 'zh/index.html')]
  for (const file of homePages) {
    const html = readFileSync(file, 'utf8')
    for (const marker of [
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'name="twitter:card"',
      'name="twitter:image"',
      'rel="canonical"'
    ]) {
      if (!html.includes(marker)) report(file, `missing launch metadata ${marker}`)
    }
  }

  const robotsFile = join(siteRoot, 'robots.txt')
  const sitemapFile = join(siteRoot, 'sitemap.xml')
  if (!existsSync(robotsFile)) report(robotsFile, 'missing robots.txt')
  else if (!readFileSync(robotsFile, 'utf8').includes(`${publicOrigin}${publicBasePath}sitemap.xml`)) {
    report(robotsFile, 'does not reference the public sitemap')
  }
  if (!existsSync(sitemapFile)) {
    report(sitemapFile, 'missing sitemap.xml')
    return
  }

  const sitemap = readFileSync(sitemapFile, 'utf8')
  const listedRoutes = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]))
  const indexableRoutes = htmlFiles
    .filter((file) => !relative(siteRoot, file).split(sep).join('/').startsWith('docs/en/'))
    .map(routeForHtml)
  for (const route of indexableRoutes) {
    if (!listedRoutes.has(route)) report(sitemapFile, `missing indexable route ${route}`)
  }
  for (const route of listedRoutes) {
    if (!route.startsWith(`${publicOrigin}${publicBasePath}`)) {
      report(sitemapFile, `unexpected origin or base path in ${route}`)
      continue
    }
    const resolved = siteFileForUrl(route, sitemapFile)
    if (!resolved || !existsSync(resolved.target)) report(sitemapFile, `listed route has no artifact: ${route}`)
  }
}

const siteFiles = await walk(siteRoot)
const htmlFiles = siteFiles.filter((file) => extname(file).toLowerCase() === '.html')
for (const file of htmlFiles) verifyHtml(file)
for (const name of ['README.md', 'README.zh.md', 'README.ja.md']) verifyReadme(join(repoRoot, name))
verifyLaunchMetadata(htmlFiles)

if (errors.length > 0) {
  console.error(`Public link/metadata check failed with ${errors.length} issue(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Public link/metadata check passed: ${htmlFiles.length} HTML pages, 3 READMEs, complete sitemap coverage.`)
