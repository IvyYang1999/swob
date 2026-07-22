import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { SettingField, Segmented, ToggleRow, useSettingsPreferences } from './shared'
import { usePlatformCapabilities } from '../WindowsAlphaNotice'

export function UpdateSettings() {
  const { savePreferences } = useStore()
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
        {t('renderer.update_settings.windows_alpha_distribution')}
      </p>
    )
  }

  return (
    <>
      <SettingField label={t('renderer.update_settings.automatic_updates')} icon={<RefreshCw size={12} />}>
        <ToggleRow
          checked={preferences.autoCheckUpdates}
          onChange={(autoCheckUpdates) => savePreferences({ autoCheckUpdates })}
          label={t('renderer.update_settings.check_for_updates_after_launch')}
          hint={t('renderer.update_settings.you_can_still_check_manually_at_any_time')}
        />
      </SettingField>
      <SettingField label={t('renderer.update_settings.update_channel')}>
        <Segmented
          ariaLabel={t('renderer.update_settings.update_channel_2')}
          value={preferences.updateChannel}
          onChange={(updateChannel) => savePreferences({ updateChannel })}
          options={[
            { value: 'stable', label: t('renderer.update_settings.stable') },
            { value: 'development', label: t('renderer.update_settings.preview') }
          ]}
        />
        <div className="mt-1 text-[10px] leading-relaxed text-faint">
          {t('renderer.update_settings.stable_official_releases_only_recommended_preview_get_new')}
        </div>
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
