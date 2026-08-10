import * as fs from 'node:fs'
import * as path from 'node:path'
import type { VerifyBundleManifest } from '../shared/contracts/truth-kernel'
import { verifyEvidenceBundle, type EvidenceBundle } from '../main/integrity/evidence-bundle'

export function verifyBundleDirectory(inputPath: string, checkedAt = new Date().toISOString()) {
  const resolvedInput = path.resolve(inputPath)
  const inputStat = fs.lstatSync(resolvedInput)
  if (inputStat.isSymbolicLink()) throw new Error('bundle-input-symlink-forbidden')
  const root = fs.realpathSync(inputStat.isDirectory() ? resolvedInput : path.dirname(resolvedInput))
  const manifestPath = inputStat.isDirectory() ? path.join(root, 'manifest.json') : fs.realpathSync(resolvedInput)
  if (manifestPath !== root && !manifestPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('bundle-manifest-outside-root')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as VerifyBundleManifest
  const files = new Map<string, Uint8Array>()
  files.set('manifest.json', fs.readFileSync(manifestPath))
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.resolve(root, artifact.relativePath)
    if (artifactPath === root || !artifactPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`bundle-artifact-outside-root:${artifact.relativePath}`)
    }
    try {
      if (fs.lstatSync(artifactPath).isSymbolicLink()) throw new Error(`bundle-artifact-symlink-forbidden:${artifact.relativePath}`)
      const physical = fs.realpathSync(artifactPath)
      if (!physical.startsWith(`${root}${path.sep}`)) throw new Error(`bundle-artifact-outside-root:${artifact.relativePath}`)
      files.set(artifact.relativePath, fs.readFileSync(physical))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return verifyEvidenceBundle({ manifest, files } satisfies EvidenceBundle, checkedAt)
}
