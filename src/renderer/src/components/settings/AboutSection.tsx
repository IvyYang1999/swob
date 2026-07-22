import { Bug, Lightbulb, MessageCircle, BookOpen, ExternalLink } from 'lucide-react'
import { useT } from '../../i18n'

const DISCORD_INVITE_URL = 'https://discord.gg/placeholder'
const DOCS_URL = 'https://github.com/IvyYang1999/swob'

function buildBugReportUrl(version: string, platform: string): string {
  const body = encodeURIComponent(`\n**Version**: ${version}\n**OS**: ${platform}`)
  return `https://github.com/IvyYang1999/swob/issues/new?template=bug_report.md&labels=bug&title=&body=${body}`
}

const WISH_URL = 'https://github.com/IvyYang1999/swob/issues/new?labels=wish&title='

function openExternal(url: string): void {
  void window.api.openExternalUrl(url).catch(() => {
    // Fallback: let the main process window open handler deal with it
    window.open(url, '_blank')
  })
}

interface LinkRowProps {
  icon: typeof Bug
  label: string
  description: string
  onClick: () => void
}

function LinkRow({ icon: Icon, label, description, onClick }: LinkRowProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left hover:bg-hover transition-colors group"
    >
      <Icon size={15} className="text-muted shrink-0 group-hover:text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-primary">{label}</span>
        <span className="block text-[10px] text-faint leading-relaxed">{description}</span>
      </span>
      <ExternalLink size={11} className="text-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  )
}

export function AboutSection({ appInfo }: { appInfo: { version: string; platform: string } | null }) {
  const t = useT()
  const version = appInfo?.version ?? ''
  const platform = appInfo?.platform ?? ''

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-secondary">
        {t('about.title')}
      </div>
      <div className="rounded-md bg-surface border border-edge overflow-hidden divide-y divide-edge">
        <LinkRow
          icon={Bug}
          label={t('about.report_bug')}
          description={t('about.bug_description')}
          onClick={() => openExternal(buildBugReportUrl(version, platform))}
        />
        <LinkRow
          icon={Lightbulb}
          label={t('about.feature_request')}
          description={t('about.wish_description')}
          onClick={() => openExternal(WISH_URL)}
        />
        <LinkRow
          icon={MessageCircle}
          label={t('about.discord')}
          description={t('about.discord_description')}
          onClick={() => openExternal(DISCORD_INVITE_URL)}
        />
        <LinkRow
          icon={BookOpen}
          label={t('about.docs')}
          description={t('about.docs_description')}
          onClick={() => openExternal(DOCS_URL)}
        />
      </div>
    </section>
  )
}
