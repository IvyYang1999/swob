import { useStore } from '../../store'
import { copy } from './shared'
import { CliSection } from './sections'

export function CliSettings() {
  const { locale } = useStore()
  return (
    <>
      <p className="text-[11px] leading-relaxed text-muted">
        {copy(locale, 'CLI 与 Agent Skill 是本地自动化入口；路径仅用于核对当前安装，不会上传。', 'CLI and Agent Skill are local automation surfaces. Paths are shown only for local verification.', 'CLI と Agent Skill はローカル自動化の入口です。パスはローカル確認のみに表示されます。')}
      </p>
      <CliSection />
    </>
  )
}
