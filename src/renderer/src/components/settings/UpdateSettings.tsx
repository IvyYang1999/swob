import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { copy, SettingField, Segmented, ToggleRow, useSettingsPreferences } from './shared'
import { usePlatformCapabilities } from '../WindowsAlphaNotice'

export function UpdateSettings() {
  const { locale, savePreferences } = useStore()
  const t = useT()
  const preferences = useSettingsPreferences()
  const isWindowsAlpha = usePlatformCapabilities()?.windowsNativeAlpha === true
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [appInfo, setAppInfo] = useState<{ version: string; platform: string } | null>(null)

  useEffect(() => {
    void window.api.getAppInfo().then(setAppInfo)
  }, [])

  if (isWindowsAlpha) {
    return (
      <p className="text-[11px] leading-relaxed text-muted">
        Windows Alpha 不提供自动更新；新版本由负责人分发未签名的 x64 NSIS 安装包。
      </p>
    )
  }

  return (
    <>
      <SettingField label={copy(locale, '自动更新', 'Automatic updates', '自動更新')} icon={<RefreshCw size={12} />}>
        <ToggleRow
          checked={preferences.autoCheckUpdates}
          onChange={(autoCheckUpdates) => savePreferences({ autoCheckUpdates })}
          label={copy(locale, '启动后自动检查更新', 'Check for updates after launch', '起動後に更新を確認')}
          hint={copy(locale, '关闭后仍可随时手动检查。', 'You can still check manually at any time.', 'いつでも手動で確認できます。')}
        />
      </SettingField>
      <SettingField label={copy(locale, '更新通道', 'Update channel', '更新チャンネル')}>
        <Segmented
          ariaLabel={copy(locale, '更新通道', 'Update channel', '更新チャンネル')}
          value={preferences.updateChannel}
          onChange={(updateChannel) => savePreferences({ updateChannel })}
          options={[
            { value: 'stable', label: copy(locale, '稳定', 'Stable', '安定版') },
            { value: 'development', label: copy(locale, '开发', 'Development', '開発版') }
          ]}
        />
      </SettingField>
      <div className="rounded-md bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
        <span>
          <span className="block text-xs text-primary">Swob {appInfo ? `v${appInfo.version}` : ''}</span>
          <span className="block mt-0.5 text-[10px] text-faint">{appInfo?.platform || ''}</span>
        </span>
        <button
          onClick={async () => {
            setCheckingUpdate(true)
            try { await window.api.checkForUpdates() } finally { setCheckingUpdate(false) }
          }}
          disabled={checkingUpdate}
          className="px-3 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40"
        >
          {checkingUpdate ? t('settings.checking_update') : t('settings.check_for_updates')}
        </button>
      </div>
    </>
  )
}
