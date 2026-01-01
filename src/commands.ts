
import VersionControlPlugin from './main';

export function registerCommands(plugin: VersionControlPlugin) {
  plugin.addCommand({
    id: 'create-version',
    name: '保存新版本',
    callback: () => plugin.createManualVersion()
  });

  plugin.addCommand({
    id: 'show-version-history',
    name: '显示版本历史',
    callback: () => plugin.activateVersionHistoryView()
  });

  plugin.addCommand({
    id: 'create-full-snapshot',
    name: '保存全库版本',
    callback: () => plugin.createFullSnapshot()
  });

  plugin.addCommand({
    id: 'compare-with-version',
    name: '与历史版本对比',
    callback: () => plugin.quickCompare()
  });

  plugin.addCommand({
    id: 'restore-last-version',
    name: '恢复到上一版本',
    callback: () => plugin.restoreLastVersion()
  });

  plugin.addCommand({
    id: 'optimize-storage',
    name: '优化存储空间',
    callback: () => plugin.optimizeAllVersionFiles()
  });

  plugin.addCommand({
    id: 'check-version-integrity',
    name: '检查版本完整性',
    callback: () => plugin.checkAllVersionsIntegrity()
  });

  plugin.addCommand({
    id: 'quick-preview-version',
    name: '快速预览上一版本',
    callback: () => plugin.quickPreviewLastVersion()
  });

  plugin.addCommand({
    id: 'star-current-version',
    name: '标记当前版本为重要',
    callback: () => plugin.starLastVersion()
  });
}
