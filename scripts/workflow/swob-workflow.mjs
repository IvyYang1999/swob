#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'

function graphFiles(input) {
  const absolute = path.resolve(input)
  if (!fs.existsSync(absolute)) throw new Error(`路径不存在: ${input}`)
  if (fs.statSync(absolute).isFile()) return [absolute]
  const files = []
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name)
    if (entry.isDirectory()) files.push(...graphFiles(child))
    else if (/^graph\.ya?ml$/i.test(entry.name)) files.push(child)
  }
  return files
}

function scopesOverlap(left, right) {
  if (left === right) return true
  const hasGlob = (value) => /[*?[]/.test(value)
  if (!hasGlob(left) && !hasGlob(right)) return false
  const prefix = (value) => value.slice(0, value.search(/[*?[]/) < 0 ? value.length : value.search(/[*?[]/))
  return prefix(left).startsWith(prefix(right)) || prefix(right).startsWith(prefix(left))
}

export function validateGraph(graph, source = '<memory>') {
  const errors = []
  const warnings = []
  const items = graph?.workItems ?? graph?.work_items ?? graph?.nodes
  if (!Array.isArray(items) || items.length === 0) return { errors: [`${source}: workItems 不能为空`], warnings }

  const byId = new Map()
  const byOwner = new Map()
  for (const [index, item] of items.entries()) {
    const label = item?.id || `#${index + 1}`
    if (!item || typeof item !== 'object') {
      errors.push(`${source}: ${label} 必须是对象`)
      continue
    }
    if (!item?.id) errors.push(`${source}: ${label} 缺少 id`)
    else if (byId.has(item.id)) errors.push(`${source}: 工作包 id 重复: ${item.id}`)
    else byId.set(item.id, item)
    if (!item?.owner) errors.push(`${source}: ${label} 缺少 owner`)
    else if (byOwner.has(item.owner)) errors.push(`${source}: Owner 重复: ${item.owner} (${byOwner.get(item.owner)}, ${label})`)
    else byOwner.set(item.owner, label)
    if (!Array.isArray(item?.evidence_required) || item.evidence_required.length === 0) {
      errors.push(`${source}: ${label} 缺少 evidence_required`)
    }
    if (item.depends_on !== undefined && !Array.isArray(item.depends_on)) errors.push(`${source}: ${label}.depends_on 必须是数组`)
    if (item.write_scope !== undefined && !Array.isArray(item.write_scope)) errors.push(`${source}: ${label}.write_scope 必须是数组`)
  }

  for (const item of items) {
    const dependencies = Array.isArray(item?.depends_on) ? item.depends_on : []
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) errors.push(`${source}: ${item.id} 依赖不存在的工作包 ${dependency}`)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = (id, chain = []) => {
    if (visiting.has(id)) {
      errors.push(`${source}: depends_on 存在环: ${[...chain, id].join(' -> ')}`)
      return
    }
    if (visited.has(id) || !byId.has(id)) return
    visiting.add(id)
    const dependencies = Array.isArray(byId.get(id).depends_on) ? byId.get(id).depends_on : []
    for (const dependency of dependencies) visit(dependency, [...chain, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) visit(id)

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftScopes = Array.isArray(items[left]?.write_scope) ? items[left].write_scope : []
      const rightScopes = Array.isArray(items[right]?.write_scope) ? items[right].write_scope : []
      const overlaps = leftScopes.flatMap((a) => rightScopes.filter((b) => scopesOverlap(a, b)).map((b) => `${a} ↔ ${b}`))
      if (overlaps.length > 0) warnings.push(`${source}: write_scope 交集 ${items[left].id}/${items[right].id}: ${overlaps.join(', ')}`)
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] }
}

export function validateFiles(inputs) {
  const files = [...new Set(inputs.flatMap(graphFiles))].sort()
  if (files.length === 0) throw new Error('没有找到 graph.yaml')
  return files.map((file) => {
    try {
      return { file, ...validateGraph(parseYaml(fs.readFileSync(file, 'utf8')), file) }
    } catch (error) {
      return { file, errors: [`${file}: YAML 解析失败: ${error.message}`], warnings: [] }
    }
  })
}

function main() {
  const [command, ...inputs] = process.argv.slice(2)
  if (command !== 'validate') {
    process.stderr.write('用法: swob-workflow validate [graph.yaml|directory...]\n')
    process.exitCode = 2
    return
  }
  try {
    const results = validateFiles(inputs.length > 0 ? inputs : ['.swob/workflows'])
    for (const result of results) {
      for (const warning of result.warnings) process.stdout.write(`WARN ${warning}\n`)
      for (const error of result.errors) process.stderr.write(`ERROR ${error}\n`)
      if (result.errors.length === 0) process.stdout.write(`OK ${result.file}\n`)
    }
    process.exitCode = results.some((result) => result.errors.length > 0) ? 1 : 0
  } catch (error) {
    process.stderr.write(`swob-workflow: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
