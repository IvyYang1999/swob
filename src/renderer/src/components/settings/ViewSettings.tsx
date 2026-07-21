import { ArrowUpDown, FolderTree, Layers3, Radio } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { copy, SettingField, Segmented, useSettingsPreferences } from './shared'

export function ViewSettings() {
  const { locale, savePreferences } = useStore()
  const t = useT()
  const preferences = useSettingsPreferences()

  return (
    <>
      <SettingField label={copy(locale, '默认视图模式', 'Default project view', '既定のプロジェクト表示')} icon={<FolderTree size={12} />}>
        <Segmented
          ariaLabel={copy(locale, '默认视图模式', 'Default project view', '既定のプロジェクト表示')}
          value={(preferences.projectViewMode === 'paths' ? 'paths' : 'folders') as 'folders' | 'paths'}
          onChange={(projectViewMode) => savePreferences({ projectViewMode })}
          options={[
            { value: 'folders', label: t('settings.project_view_folders') },
            { value: 'paths', label: t('settings.project_view_paths') }
          ]}
        />
      </SettingField>
      <SettingField label={copy(locale, '默认排序', 'Default sort', '既定の並び順')} icon={<ArrowUpDown size={12} />}>
        <Segmented
          ariaLabel={copy(locale, '默认排序', 'Default sort', '既定の並び順')}
          value={preferences.defaultSort}
          onChange={(defaultSort) => savePreferences({ defaultSort })}
          options={[
            { value: 'updated', label: copy(locale, '最近更新', 'Recently updated', '最近の更新') },
            { value: 'created', label: copy(locale, '创建时间', 'Created', '作成日時') },
            { value: 'turns', label: copy(locale, '轮数', 'Turns', 'ターン数') },
            { value: 'name', label: copy(locale, '名称', 'Name', '名前') }
          ]}
        />
      </SettingField>
      <SettingField label={copy(locale, '默认分组', 'Default grouping', '既定のグループ')} icon={<Layers3 size={12} />}>
        <Segmented
          ariaLabel={copy(locale, '默认分组', 'Default grouping', '既定のグループ')}
          value={preferences.defaultGrouping}
          onChange={(defaultGrouping) => savePreferences({ defaultGrouping })}
          options={[
            { value: 'none', label: copy(locale, '无', 'None', 'なし') },
            { value: 'project', label: copy(locale, '按项目', 'Project', 'プロジェクト') },
            { value: 'date', label: copy(locale, '按日期', 'Date', '日付') },
            { value: 'harness', label: 'Harness' }
          ]}
        />
      </SettingField>
      <SettingField label={copy(locale, '单轮会话处理', 'Single-turn sessions', '単一ターンのセッション')} icon={<Radio size={12} />}>
        <Segmented
          ariaLabel={copy(locale, '单轮会话处理', 'Single-turn sessions', '単一ターンのセッション')}
          value={preferences.singleTurnBehavior}
          onChange={(singleTurnBehavior) => savePreferences({ singleTurnBehavior })}
          options={[
            { value: 'show', label: copy(locale, '显示', 'Show', '表示') },
            { value: 'hide', label: copy(locale, '隐藏', 'Hide', '非表示') },
            { value: 'collapse', label: copy(locale, '折叠', 'Collapse', '折りたたむ') }
          ]}
        />
      </SettingField>
    </>
  )
}
