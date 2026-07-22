import { useT } from '../../i18n'
import { CliSection } from './sections'

export function CliSettings() {
  const t = useT()
  return (
    <>
      <p className="text-[11px] leading-relaxed text-muted">
        {t('renderer.cli_settings.cli_and_agent_skill_are_local_automation_surfaces')}
      </p>
      <CliSection />
    </>
  )
}
