
export interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content?: string;
    diff?: string;
    baseVersionId?: string; // 用于链式增量存储
    size: number;
    hash?: string;
    tags?: string[];
    note?: string;
    starred?: boolean;
    addedLines?: number;
    removedLines?: number;
    modifiedLines?: number;
}

export interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
    baseVersion?: string; // 保留用于向后兼容
    versionIndex?: Map<string, number>;
}

export interface VersionControlSettings {
    versionFolder: string;
    autoSave: boolean;
    autoSaveInterval: number;

    autoClear: boolean;
    maxVersions: number;
    enableMaxVersions: boolean;
    maxDays: number;
    enableMaxDays: boolean;

    useRelativeTime: boolean;
    diffGranularity: 'char' | 'word' | 'line';
    diffViewMode: 'unified' | 'split';
    enableDeduplication: boolean;
    showNotifications: boolean;
    excludedFolders: string[];
    enableCompression: boolean;
    enableIncrementalStorage: boolean;
    versionsPerPage: number;
    rebuildBaseInterval: number;

    autoSaveOnModify: boolean;
    autoSaveMinChanges: number;
    autoSaveOnInterval: boolean;

    autoSaveDelayOnModify: number;

    enableQuickPreview: boolean;
    enableVersionTags: boolean;
    defaultTags: string[];
    showVersionStats: boolean;
    enableStatusBarDiff: boolean;
    showLastSaveTimeInStatusBar: boolean;

    inlineDiffAlgorithm: 'word' | 'char' | 'line';
    // smartWordDiff: boolean; // Removed
    diffContextLines: number;
    compactUnifiedDiff: boolean;
}

// 视图模式类型定义
export type ViewMode = 'current' | 'modified' | 'global';
