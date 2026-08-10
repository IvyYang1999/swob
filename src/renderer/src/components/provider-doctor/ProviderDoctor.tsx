import { useMemo } from 'react'
import type { ProviderManifest } from '../../../../shared/provider-schema-v2.generated'
import { createT211BTranslator, type T211BLocale, type T211BTranslationKey } from '../timeline/translations'
import {
  productionProviderParityFixtures,
  sanitizeProviderDiagnosticText,
  type ProviderParityFixture
} from './provider-parity'

export interface ProviderDoctorInput {
  manifest: ProviderManifest
  discovery: 'found' | 'not-found' | 'skipped' | 'error'
  discoveryReason: string | null
  lastSuccessfulParseAt: string | null
  unknownEvents: number
  partialEvents: number
  sourceLabel: string
  executionDomain: 'native' | 'wsl' | 'unknown'
}

const STATUS_KEY: Record<string, T211BTranslationKey> = {
  available: 'doctor.capability.exact', exact: 'doctor.capability.exact', experimental: 'doctor.capability.derived', derived: 'doctor.capability.derived', estimated: 'doctor.capability.estimated', unavailable: 'doctor.unavailable', 'not-applicable': 'doctor.unavailable'
}
const DISCOVERY_KEY: Record<ProviderDoctorInput['discovery'], T211BTranslationKey> = {
  found: 'doctor.discovery.found', 'not-found': 'doctor.discovery.notFound', skipped: 'doctor.discovery.skipped', error: 'doctor.discovery.error'
}
const DOMAIN_KEY: Record<ProviderDoctorInput['executionDomain'], T211BTranslationKey> = {
  native: 'doctor.domain.native', wsl: 'doctor.domain.wsl', unknown: 'doctor.domain.unknown'
}

/** Dynamic doctor: manifests, not a handwritten provider list, define rows. */
export function ProviderDoctor({ providers, locale = 'en' }: { providers: readonly ProviderDoctorInput[]; locale?: T211BLocale }) {
  const t = useMemo(() => createT211BTranslator(locale), [locale])
  return <section aria-label={t('doctor.label')} className="space-y-3">
    <header><h2 className="text-sm font-semibold text-primary">{t('doctor.label')}</h2><p className="text-xs text-muted">{t('doctor.description')}</p></header>
    {providers.map((provider) => <article key={`${provider.manifest.providerId}:${provider.sourceLabel}`} className="rounded-lg border border-edge/60 p-3">
      <div className="flex flex-wrap gap-x-3 gap-y-1"><strong>{provider.manifest.displayName}</strong><span className="text-xs text-muted">{sanitizeProviderDiagnosticText(provider.sourceLabel)} · {t(DOMAIN_KEY[provider.executionDomain])}</span></div>
      <p className="mt-1 text-xs text-muted">{t('doctor.discovery', { state: t(DISCOVERY_KEY[provider.discovery]) })}{provider.discoveryReason ? ` — ${sanitizeProviderDiagnosticText(provider.discoveryReason)}` : ''} · {t('doctor.parser', { version: provider.manifest.parserDataVersion })} · {t('doctor.lastParsed', { value: provider.lastSuccessfulParseAt ?? t('doctor.unavailable') })}</p>
      <p className="mt-1 text-xs text-muted">{t('doctor.unknown', { count: provider.unknownEvents })} · {t('doctor.partial', { count: provider.partialEvents })} · {t('doctor.resume', { value: provider.manifest.resumeContract ? provider.manifest.resumeContract.mode : t('doctor.unavailable') })}</p>
      <dl className="mt-2 grid grid-cols-2 gap-1 text-xs md:grid-cols-3">
        {Object.entries(provider.manifest.capabilities).map(([capability, declaration]) => <div key={capability} className="rounded bg-surface/50 px-2 py-1">
          <dt className="text-muted">{capability}</dt><dd data-capability-status={declaration.status}>{t(STATUS_KEY[declaration.status] ?? 'doctor.unavailable')}{declaration.reason ? ` · ${declaration.reason}` : ''}</dd>
        </div>)}
      </dl>
    </article>)}
  </section>
}

/** Production Registry projection; t211I only places this feature-local view in Settings. */
export function ProductionProviderDoctor({ locale = 'en', fixtures = productionProviderParityFixtures() }: { locale?: T211BLocale; fixtures?: readonly ProviderParityFixture[] }) {
  const t = useMemo(() => createT211BTranslator(locale), [locale])
  return <section aria-label={t('doctor.label')} className="space-y-3">
    <header><h2 className="text-sm font-semibold text-primary">{t('doctor.label')}</h2><p className="text-xs text-muted">{t('doctor.description')}</p></header>
    {fixtures.map((provider) => <article key={provider.providerId} className="rounded-lg border border-edge/60 p-3" data-provider-id={provider.providerId}>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1"><strong className="truncate">{provider.displayName}</strong><span className="text-xs text-muted">{provider.discoveryCategory}</span></div>
      <p className="mt-1 break-words text-xs text-muted">{t('doctor.adapter', { value: provider.adapterVersion })} · {t('doctor.format', { value: provider.formatVersions.join(', ') })} · {t('doctor.fixtures', { count: provider.fixturePaths.length })}</p>
      <dl className="mt-2 grid grid-cols-2 gap-1 text-xs md:grid-cols-3">
        {Object.values(provider.capabilities).map((capability) => <div key={capability.capability} className="min-w-0 rounded bg-surface/50 px-2 py-1">
          <dt className="truncate text-muted">{capability.capability}</dt><dd className="break-words" data-capability-status={capability.truth}>{t(STATUS_KEY[capability.truth])} · {sanitizeProviderDiagnosticText(capability.reason)}</dd>
        </div>)}
      </dl>
    </article>)}
  </section>
}
