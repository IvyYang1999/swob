import { ArrowUpDown, FolderTree, Layers3, Radio } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { SettingField, Segmented, useSettingsPreferences } from './shared'

export function ViewSettings() {
  const { savePreferences } = useStore()
  const t = useT()
  const preferences = useSettingsPreferences()

  return (
    <>
      <SettingField label={t('renderer.view_settings.default_project_view')} icon={<FolderTree size={12} />}>
        <Segmented
          ariaLabel={t('renderer.view_settings.default_project_view_2')}
          value={(preferences.projectViewMode === 'paths' ? 'paths' : 'folders') as 'folders' | 'paths'}
          onChange={(projectViewMode) => savePreferences({ projectViewMode })}
          options={[
            { value: 'folders', label: t('settings.project_view_folders') },
            { value: 'paths', label: t('settings.project_view_paths') }
          ]}
        />
      </SettingField>
      <SettingField label={t('renderer.view_settings.default_sort')} icon={<ArrowUpDown size={12} />}>
        <Segmented
          ariaLabel={t('renderer.view_settings.default_sort_2')}
          value={preferences.defaultSort}
          onChange={(defaultSort) => savePreferences({ defaultSort })}
          options={[
            { value: 'updated', label: t('renderer.view_settings.recently_updated') },
            { value: 'created', label: t('renderer.view_settings.created') },
            { value: 'turns', label: t('renderer.view_settings.turns') },
            { value: 'name', label: t('renderer.view_settings.name') }
          ]}
        />
      </SettingField>
      <SettingField label={t('renderer.view_settings.default_grouping')} icon={<Layers3 size={12} />}>
        <Segmented
          ariaLabel={t('renderer.view_settings.default_grouping_2')}
          value={preferences.defaultGrouping}
          onChange={(defaultGrouping) => savePreferences({ defaultGrouping })}
          options={[
            { value: 'none', label: t('renderer.view_settings.none') },
            { value: 'project', label: t('renderer.view_settings.project') },
            { value: 'date', label: t('renderer.view_settings.date') },
            { value: 'harness', label: 'Harness' }
          ]}
        />
      </SettingField>
      <SettingField label={t('renderer.view_settings.single_turn_sessions')} icon={<Radio size={12} />}>
        <Segmented
          ariaLabel={t('renderer.view_settings.single_turn_sessions_2')}
          value={preferences.singleTurnBehavior}
          onChange={(singleTurnBehavior) => savePreferences({ singleTurnBehavior })}
          options={[
            { value: 'show', label: t('renderer.view_settings.show') },
            { value: 'hide', label: t('renderer.view_settings.hide') },
            { value: 'collapse', label: t('renderer.view_settings.collapse') }
          ]}
        />
      </SettingField>
    </>
  )
}
