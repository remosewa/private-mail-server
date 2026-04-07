import { useState, useEffect } from 'react';
import { useLabelStore } from '../../store/labelStore';
import { useFolderStore } from '../../store/folderStore';
import { putFilter, deleteFilter, listFilters, type SavedFilter } from '../../api/filters';
import { executeFilter } from '../../sync/filterExecutor';
import { useFilterStore } from '../../store/filterStore';

export interface FilterCondition {
  field: 'subject' | 'body' | 'from' | 'to' | 'cc' | 'date' | 'hasAttachment' | 'label' | 'readStatus';
  operator: 'equals' | 'startsWith' | 'endsWith' | 'contains' | 'before' | 'after' | 'between' | 'hasLabel' | 'notHasLabel' | 'hasAttachment' | 'notHasAttachment' | 'isRead' | 'isUnread';
  value: string | string[];
}

export interface FilterGroup {
  operator: 'AND' | 'OR';
  conditions: FilterCondition[];
}

export interface EmailFilter {
  operator: 'AND' | 'OR';
  groups: FilterGroup[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  filter: EmailFilter;
  onFilterChange: (filter: EmailFilter) => void;
  sourceFolderId?: string;
}

type ViewMode = 'ui' | 'json' | 'actions';

export default function FilterModal({ isOpen, onClose, filter, onFilterChange, sourceFolderId }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('ui');
  const [jsonValue, setJsonValue] = useState('');
  const [jsonError, setJsonError] = useState('');
  const { labels } = useLabelStore();
  const { folders } = useFolderStore();
  const filterProgress = useFilterStore(state => state.progress);
  
  // Saved filters state
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [currentFilterId, setCurrentFilterId] = useState<string | null>(null);
  const [currentFilterVersion, setCurrentFilterVersion] = useState<number>(1);
  const [showSaveAsDialog, setShowSaveAsDialog] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showLoadDropdown, setShowLoadDropdown] = useState(false);
  const [saveConfirmation, setSaveConfirmation] = useState<string | null>(null);
  const [loadingFilters, setLoadingFilters] = useState(false);
  
  // Actions state
  const [actionMode, setActionMode] = useState<'once' | 'always'>('once');
  const [actionFolder, setActionFolder] = useState<string>('');
  const [actionLabelsEnabled, setActionLabelsEnabled] = useState(false);
  const [actionLabels, setActionLabels] = useState<string[]>([]);
  const [actionLabelMode, setActionLabelMode] = useState<'add' | 'remove' | 'set'>('add');
  const [actionMarkAsRead, setActionMarkAsRead] = useState<boolean | undefined>(undefined);
  const [actionRunning, setActionRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Load saved filters from server
  useEffect(() => {
    if (isOpen) {
      loadFiltersFromServer();
    }
  }, [isOpen]);

  const loadFiltersFromServer = async () => {
    setLoadingFilters(true);
    try {
      const response = await listFilters();
      setSavedFilters(response.filters);
    } catch (err) {
      console.error('Failed to load filters:', err);
    } finally {
      setLoadingFilters(false);
    }
  };

  // Close load dropdown on outside click
  useEffect(() => {
    if (!showLoadDropdown) return;
    
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.load-dropdown-container')) {
        setShowLoadDropdown(false);
      }
    };
    
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showLoadDropdown]);

  // Clear save confirmation after 3 seconds
  useEffect(() => {
    if (!saveConfirmation) return;
    
    const timer = setTimeout(() => {
      setSaveConfirmation(null);
    }, 3000);
    
    return () => clearTimeout(timer);
  }, [saveConfirmation]);

  // Save current filter (overwrite if one is loaded)
  const handleSave = async () => {
    if (!currentFilterId) {
      // No filter loaded, show save as dialog
      setShowSaveAsDialog(true);
      return;
    }

    const currentFilter = savedFilters.find(f => f.filterId === currentFilterId);
    if (!currentFilter) {
      setSaveError('Filter not found');
      return;
    }

    try {
      await putFilter(currentFilterId, {
        name: currentFilter.name,
        filter,
        actions: currentFilter.actions,
        version: currentFilterVersion,
      });

      setSaveConfirmation(`Saved "${currentFilter.name}"`);
      await loadFiltersFromServer();
    } catch (error: any) {
      if (error.response?.status === 409) {
        setSaveError('Filter was modified by another client. Please reload.');
      } else {
        setSaveError(error.message || 'Failed to save filter');
      }
    }
  };

  // Save as new filter
  const handleSaveAs = async () => {
    const name = saveFilterName.trim();
    if (!name) {
      setSaveError('Please enter a filter name');
      return;
    }

    // Check if name already exists
    if (savedFilters.find(f => f.name === name)) {
      setSaveError('A filter with this name already exists');
      return;
    }

    try {
      // Generate a new filterId
      const filterId = `filter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      await putFilter(filterId, {
        name,
        filter,
      });

      setCurrentFilterId(filterId);
      setCurrentFilterVersion(1);
      setSaveFilterName('');
      setSaveError('');
      setShowSaveAsDialog(false);
      setSaveConfirmation(`Created "${name}"`);
      await loadFiltersFromServer();
    } catch (error: any) {
      setSaveError(error.message || 'Failed to create filter');
    }
  };

  const handleLoadFilter = (savedFilter: SavedFilter) => {
    onFilterChange(savedFilter.filter);
    setCurrentFilterId(savedFilter.filterId);
    setCurrentFilterVersion(savedFilter.version);
    setShowLoadDropdown(false);
    
    // Load actions if present
    if (savedFilter.actions) {
      setActionMode(savedFilter.actions.mode);
      setActionFolder(savedFilter.actions.folder || '');
      if (savedFilter.actions.labels) {
        setActionLabelsEnabled(true);
        setActionLabelMode(savedFilter.actions.labels.mode);
        setActionLabels(savedFilter.actions.labels.labelIds);
      } else {
        setActionLabelsEnabled(false);
        setActionLabels([]);
      }
      setActionMarkAsRead(savedFilter.actions.markAsRead);
    } else {
      setActionMode('once');
      setActionFolder('');
      setActionLabelsEnabled(false);
      setActionLabels([]);
      setActionMarkAsRead(undefined);
    }
  };

  const handleDeleteSavedFilter = async (filterId: string, name: string) => {
    try {
      await deleteFilter(filterId);
      if (currentFilterId === filterId) {
        setCurrentFilterId(null);
        setCurrentFilterVersion(1);
      }
      setSaveConfirmation(`Deleted "${name}"`);
      await loadFiltersFromServer();
    } catch (error: any) {
      setSaveError(error.message || 'Failed to delete filter');
    }
  };

  const handleDeleteCurrentFilter = async () => {
    if (!currentFilterId) return;
    
    const currentFilter = savedFilters.find(f => f.filterId === currentFilterId);
    if (!currentFilter) return;
    
    if (confirm(`Delete the filter "${currentFilter.name}"?`)) {
      await handleDeleteSavedFilter(currentFilterId, currentFilter.name);
    }
  };

  useEffect(() => {
    if (viewMode === 'ui') {
      setJsonValue(JSON.stringify(filter, null, 2));
    }
  }, [filter, viewMode]);

  const addGroup = () => {
    const newGroup: FilterGroup = {
      operator: 'OR',
      conditions: [{ field: 'subject', operator: 'contains', value: '' }],
    };
    onFilterChange({ ...filter, groups: [...filter.groups, newGroup] });
  };

  const removeGroup = (groupIndex: number) => {
    onFilterChange({
      ...filter,
      groups: filter.groups.filter((_, i) => i !== groupIndex),
    });
  };

  const updateGroup = (groupIndex: number, updates: Partial<FilterGroup>) => {
    onFilterChange({
      ...filter,
      groups: filter.groups.map((g, i) => (i === groupIndex ? { ...g, ...updates } : g)),
    });
  };

  const addConditionToGroup = (groupIndex: number) => {
    const newCondition: FilterCondition = { field: 'subject', operator: 'contains', value: '' };
    const updatedGroups = [...filter.groups];
    updatedGroups[groupIndex] = {
      ...updatedGroups[groupIndex],
      conditions: [...updatedGroups[groupIndex].conditions, newCondition],
    };
    onFilterChange({ ...filter, groups: updatedGroups });
  };

  const removeConditionFromGroup = (groupIndex: number, conditionIndex: number) => {
    const updatedGroups = [...filter.groups];
    updatedGroups[groupIndex] = {
      ...updatedGroups[groupIndex],
      conditions: updatedGroups[groupIndex].conditions.filter((_, i) => i !== conditionIndex),
    };
    if (updatedGroups[groupIndex].conditions.length === 0) {
      updatedGroups.splice(groupIndex, 1);
    }
    onFilterChange({ ...filter, groups: updatedGroups });
  };

  const updateCondition = (groupIndex: number, conditionIndex: number, updates: Partial<FilterCondition>) => {
    const updatedGroups = [...filter.groups];
    updatedGroups[groupIndex] = {
      ...updatedGroups[groupIndex],
      conditions: updatedGroups[groupIndex].conditions.map((c, i) =>
        i === conditionIndex ? { ...c, ...updates } : c
      ),
    };
    onFilterChange({ ...filter, groups: updatedGroups });
  };

  const toggleRootOperator = () => {
    onFilterChange({ ...filter, operator: filter.operator === 'AND' ? 'OR' : 'AND' });
  };

  const toggleGroupOperator = (groupIndex: number) => {
    updateGroup(groupIndex, {
      operator: filter.groups[groupIndex].operator === 'AND' ? 'OR' : 'AND',
    });
  };

  const switchToJsonView = () => {
    setJsonValue(JSON.stringify(filter, null, 2));
    setJsonError('');
    setViewMode('json');
  };

  const switchToUiView = () => {
    try {
      const parsed = JSON.parse(jsonValue) as EmailFilter;
      if (!parsed.operator || !Array.isArray(parsed.groups)) {
        throw new Error('Invalid filter structure');
      }
      onFilterChange(parsed);
      setJsonError('');
      setViewMode('ui');
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  const getOperatorsForField = (field: FilterCondition['field']): FilterCondition['operator'][] => {
    if (field === 'date') return ['before', 'after', 'between'];
    if (field === 'hasAttachment') return ['hasAttachment', 'notHasAttachment'];
    if (field === 'label') return ['hasLabel', 'notHasLabel'];
    if (field === 'readStatus') return ['isRead', 'isUnread'];
    if (field === 'body') return ['contains', 'startsWith'];
    return ['equals', 'startsWith', 'endsWith', 'contains'];
  };

  const clearFilters = () => {
    onFilterChange({ operator: 'AND', groups: [] });
  };

  // Handle running the filter action
  const handleRunAction = async () => {
    if (actionMode === 'once') {
      // Run once - execute filter against all emails
      if (!actionFolder && !actionLabelsEnabled && actionMarkAsRead === undefined) {
        setActionError('Please configure at least one action (folder, labels, or read status)');
        return;
      }

      if (actionLabelsEnabled && actionLabels.length === 0) {
        setActionError('Please select at least one label');
        return;
      }

      // Check if another filter is already running
      if (filterProgress && filterProgress.running) {
        setActionError('Another filter is currently running. Please wait or cancel it first.');
        return;
      }

      setActionRunning(true);
      setActionError(null);

      try {
        // Use current filter ID if available, otherwise generate a temporary one
        const filterId = currentFilterId || `temp_${Date.now()}`;
        const filterName = currentFilterId 
          ? savedFilters.find(f => f.filterId === currentFilterId)?.name || 'Unnamed Filter'
          : 'Temporary Filter';

        await executeFilter({
          filterId,
          filterName,
          filter,
          sourceFolderId,
          folderId: actionFolder || undefined,
          labelIds: actionLabelsEnabled ? actionLabels : undefined,
          labelMode: actionLabelsEnabled ? actionLabelMode : undefined,
          markAsRead: actionMarkAsRead,
          onComplete: (updated) => {
            setActionRunning(false);
            setSaveConfirmation(`Filter applied to ${updated} email${updated !== 1 ? 's' : ''}`);
          },
          onError: (error) => {
            setActionRunning(false);
            setActionError(error.message);
          },
        });
      } catch (error) {
        setActionRunning(false);
        setActionError(error instanceof Error ? error.message : 'Failed to run filter');
      }
    } else {
      // Run always - save filter with enabled flag
      if (!currentFilterId) {
        setActionError('Please save the filter first to enable automatic actions');
        return;
      }

      const currentFilter = savedFilters.find(f => f.filterId === currentFilterId);
      if (!currentFilter) {
        setActionError('Filter not found');
        return;
      }

      if (!actionFolder && !actionLabelsEnabled && actionMarkAsRead === undefined) {
        setActionError('Please configure at least one action (folder, labels, or read status)');
        return;
      }

      if (actionLabelsEnabled && actionLabels.length === 0) {
        setActionError('Please select at least one label');
        return;
      }

      setActionRunning(true);
      setActionError(null);

      try {
        await putFilter(currentFilterId, {
          name: currentFilter.name,
          filter,
          actions: {
            mode: 'always',
            folder: actionFolder || undefined,
            labels: actionLabelsEnabled ? {
              mode: actionLabelMode,
              labelIds: actionLabels,
            } : undefined,
            markAsRead: actionMarkAsRead,
          },
          version: currentFilterVersion,
        });

        setActionRunning(false);
        setSaveConfirmation('Automatic actions enabled');
        await loadFiltersFromServer();
      } catch (error: any) {
        setActionRunning(false);
        if (error.response?.status === 409) {
          setActionError('Filter was modified by another client. Please reload.');
        } else {
          setActionError(error.message || 'Failed to enable automatic actions');
        }
      }
    }
  };

  const totalConditions = filter.groups.reduce((sum, g) => sum + g.conditions.length, 0);

  // Get current filter name for display
  const currentFilterName = currentFilterId 
    ? savedFilters.find(f => f.filterId === currentFilterId)?.name 
    : null;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Email Filters</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Save/Load Bar */}
        <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
          {/* Save Confirmation */}
          {saveConfirmation && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800
                            text-green-700 dark:text-green-300 text-sm flex items-center gap-2">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {saveConfirmation}
            </div>
          )}
          
          <div className="flex items-center gap-2">
            {/* Load Dropdown */}
            <div className="relative flex-1 load-dropdown-container">
              <button
                onClick={() => setShowLoadDropdown(!showLoadDropdown)}
                disabled={loadingFilters}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                           bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300
                           hover:bg-gray-50 dark:hover:bg-gray-700
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {loadingFilters ? (
                    <>
                      <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                      </svg>
                      <span className="truncate">Loading filters...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 3h18v18H3z" />
                        <path d="M9 3v18" />
                      </svg>
                      <span className="truncate">
                        {currentFilterName || (savedFilters.length === 0 ? 'No saved filters' : 'Load saved filter...')}
                      </span>
                      {currentFilterName && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCurrentFilter();
                          }}
                          className="ml-auto p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30
                                     text-red-600 dark:text-red-400 transition-colors"
                          title={`Delete "${currentFilterName}"`}
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </>
                  )}
                </div>
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showLoadDropdown && savedFilters.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-white dark:bg-gray-800
                                border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto">
                  {savedFilters.map((savedFilter) => (
                    <div
                      key={savedFilter.filterId}
                      className="flex items-center justify-between px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 group"
                    >
                      <button
                        onClick={() => handleLoadFilter(savedFilter)}
                        className="flex-1 text-left text-sm text-gray-900 dark:text-gray-100 truncate"
                      >
                        {savedFilter.name}
                        {currentFilterId === savedFilter.filterId && (
                          <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">(current)</span>
                        )}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete the filter "${savedFilter.name}"?`)) {
                            handleDeleteSavedFilter(savedFilter.filterId, savedFilter.name);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30
                                   text-red-600 dark:text-red-400 transition-opacity"
                        title="Delete saved filter"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Save Button (overwrites current) */}
            <button
              onClick={handleSave}
              disabled={totalConditions === 0 || !currentFilterName}
              className="px-4 py-2 text-sm font-medium rounded-lg
                         text-white bg-blue-600 hover:bg-blue-700
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors flex items-center gap-2"
              title={!currentFilterName ? 'Load a filter first to overwrite it' : `Save changes to "${currentFilterName}"`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              Save
            </button>

            {/* Save As Button (create new) */}
            <button
              onClick={() => setShowSaveAsDialog(true)}
              disabled={totalConditions === 0}
              className="p-2 text-sm font-medium rounded-lg
                         text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20
                         hover:bg-blue-100 dark:hover:bg-blue-900/40
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
              title="Save as new filter"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Save As Dialog */}
        {showSaveAsDialog && (
          <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/20">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                New Filter Name
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={saveFilterName}
                  onChange={(e) => {
                    setSaveFilterName(e.target.value);
                    setSaveError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveAs();
                    if (e.key === 'Escape') {
                      setShowSaveAsDialog(false);
                      setSaveFilterName('');
                      setSaveError('');
                    }
                  }}
                  placeholder="Enter a name for this filter"
                  className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                             bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <button
                  onClick={handleSaveAs}
                  className="px-4 py-2 text-sm font-medium rounded-lg
                             text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setShowSaveAsDialog(false);
                    setSaveFilterName('');
                    setSaveError('');
                  }}
                  className="px-4 py-2 text-sm font-medium rounded-lg
                             text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700
                             hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {saveError && (
                <p className="text-xs text-red-600 dark:text-red-400">{saveError}</p>
              )}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 px-6">
          <button
            onClick={() => {
              if (viewMode === 'json') {
                switchToUiView();
              } else {
                setViewMode('ui');
              }
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              viewMode === 'ui'
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Visual
          </button>
          <button
            onClick={switchToJsonView}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              viewMode === 'json'
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Advanced (JSON)
          </button>
          <button
            onClick={() => setViewMode('actions')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              viewMode === 'actions'
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
            title="Configure actions for this filter"
          >
            Actions
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {viewMode === 'ui' ? (
            <div className="space-y-4">
              {/* Root Operator Info */}
              {filter.groups.length > 1 && (
                <div className="flex items-center gap-2 pb-3 mb-3 border-b border-gray-200 dark:border-gray-700">
                  <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Groups are combined with <span className="font-semibold text-blue-600 dark:text-blue-400">{filter.operator}</span> logic.
                    Click the <span className="font-semibold">{filter.operator}</span> button between groups to toggle.
                  </span>
                </div>
              )}

              {/* Groups */}
              {filter.groups.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  No filters applied. Click "Add Group" to start filtering.
                </div>
              ) : (
                <div className="space-y-4">
                  {filter.groups.map((group, groupIndex) => (
                    <div key={groupIndex}>
                      <div className="p-4 rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                        {/* Group Header */}
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Group {groupIndex + 1}</span>
                          <button
                            onClick={() => removeGroup(groupIndex)}
                            className="p-1 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
                            title="Remove group"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>

                        {/* Conditions */}
                        <div className="space-y-2">
                          {group.conditions.map((condition, conditionIndex) => (
                            <div key={conditionIndex}>
                              <div className="flex items-start gap-2 p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                                <div className="flex-1 space-y-2">
                                  <div className="flex gap-2">
                                    <select
                                      value={condition.field}
                                      onChange={(e) => {
                                        const newField = e.target.value as FilterCondition['field'];
                                        const operators = getOperatorsForField(newField);
                                        updateCondition(groupIndex, conditionIndex, {
                                          field: newField,
                                          operator: operators[0],
                                          value: (newField === 'hasAttachment' || newField === 'readStatus') ? 'true' : '',
                                        });
                                      }}
                                      className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                      <option value="subject">Subject</option>
                                      <option value="body">Body</option>
                                      <option value="from">From</option>
                                      <option value="to">To</option>
                                      <option value="cc">CC</option>
                                      <option value="date">Date</option>
                                      <option value="label">Label</option>
                                      <option value="hasAttachment">Has Attachment</option>
                                      <option value="readStatus">Read Status</option>
                                    </select>

                                    {/* Operator dropdown - hide for hasAttachment/readStatus since Yes/No controls it */}
                                    {condition.field !== 'hasAttachment' && condition.field !== 'readStatus' && (
                                      <select
                                        value={condition.operator}
                                        onChange={(e) =>
                                          updateCondition(groupIndex, conditionIndex, {
                                            operator: e.target.value as FilterCondition['operator'],
                                          })
                                        }
                                        className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                   bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                   focus:outline-none focus:ring-2 focus:ring-blue-500"
                                      >
                                        {getOperatorsForField(condition.field).map((op) => (
                                          <option key={op} value={op}>
                                            {op === 'startsWith'
                                              ? 'Starts with'
                                              : op === 'endsWith'
                                              ? 'Ends with'
                                              : op === 'contains'
                                              ? 'Contains'
                                              : op === 'hasLabel'
                                              ? 'Has label'
                                              : op === 'notHasLabel'
                                              ? 'Does not have label'
                                              : op === 'hasAttachment'
                                              ? 'Has attachments'
                                              : op === 'notHasAttachment'
                                              ? 'No attachments'
                                              : op.charAt(0).toUpperCase() + op.slice(1)}
                                          </option>
                                        ))}
                                      </select>
                                    )}
                                  </div>

                                  {/* Value Input */}
                                  {condition.field === 'label' ? (
                                    <select
                                      value={String(condition.value)}
                                      onChange={(e) => updateCondition(groupIndex, conditionIndex, { value: e.target.value })}
                                      className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                      <option value="">Select a label...</option>
                                      {labels.map((label) => (
                                        <option key={label.id} value={label.id}>
                                          {label.name}
                                        </option>
                                      ))}
                                    </select>
                                  ) : condition.field === 'hasAttachment' ? (
                                    <select
                                      value={condition.operator}
                                      onChange={(e) => updateCondition(groupIndex, conditionIndex, {
                                        operator: e.target.value as FilterCondition['operator'],
                                        value: 'true'
                                      })}
                                      className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                      <option value="hasAttachment">Yes</option>
                                      <option value="notHasAttachment">No</option>
                                    </select>
                                  ) : condition.field === 'readStatus' ? (
                                    <select
                                      value={condition.operator}
                                      onChange={(e) => updateCondition(groupIndex, conditionIndex, {
                                        operator: e.target.value as FilterCondition['operator'],
                                        value: 'true'
                                      })}
                                      className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                      <option value="isUnread">Unread</option>
                                      <option value="isRead">Read</option>
                                    </select>
                                  ) : condition.field === 'date' && condition.operator === 'between' ? (
                                    <div className="flex gap-2">
                                      <input
                                        type="date"
                                        value={Array.isArray(condition.value) ? condition.value[0] || '' : ''}
                                        onChange={(e) => {
                                          const current = Array.isArray(condition.value) ? condition.value : ['', ''];
                                          updateCondition(groupIndex, conditionIndex, { value: [e.target.value, current[1] || ''] });
                                        }}
                                        className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                   bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                   focus:outline-none focus:ring-2 focus:ring-blue-500"
                                      />
                                      <span className="text-gray-500 dark:text-gray-400 self-center">to</span>
                                      <input
                                        type="date"
                                        value={Array.isArray(condition.value) ? condition.value[1] || '' : ''}
                                        onChange={(e) => {
                                          const current = Array.isArray(condition.value) ? condition.value : ['', ''];
                                          updateCondition(groupIndex, conditionIndex, { value: [current[0] || '', e.target.value] });
                                        }}
                                        className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                   bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                   focus:outline-none focus:ring-2 focus:ring-blue-500"
                                      />
                                    </div>
                                  ) : condition.field === 'date' ? (
                                    <input
                                      type="date"
                                      value={String(condition.value)}
                                      onChange={(e) => updateCondition(groupIndex, conditionIndex, { value: e.target.value })}
                                      className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                  ) : (
                                    <input
                                      type="text"
                                      value={String(condition.value)}
                                      onChange={(e) => updateCondition(groupIndex, conditionIndex, { value: e.target.value })}
                                      placeholder="Enter value (use * as wildcard)"
                                      className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                                 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                                 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                  )}
                                </div>

                                <button
                                  onClick={() => removeConditionFromGroup(groupIndex, conditionIndex)}
                                  className="p-1 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 mt-1"
                                  title="Remove condition"
                                >
                                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                  </svg>
                                </button>
                              </div>

                              {/* AND/OR between conditions */}
                              {conditionIndex < group.conditions.length - 1 && (
                                <div className="flex items-center justify-center py-1">
                                  <button
                                    onClick={() => toggleGroupOperator(groupIndex)}
                                    className="px-3 py-1 text-xs font-bold rounded-full border-2 border-gray-300 dark:border-gray-600
                                               bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300
                                               hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400
                                               transition-colors shadow-sm"
                                    title="Click to toggle between AND/OR"
                                  >
                                    {group.operator}
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>

                        {/* Add Condition */}
                        <button
                          onClick={() => addConditionToGroup(groupIndex)}
                          className="w-full mt-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-dashed border-gray-300 dark:border-gray-600
                                     text-gray-600 dark:text-gray-400 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400
                                     transition-colors flex items-center justify-center gap-1"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                          </svg>
                          Add Condition
                        </button>
                      </div>

                      {/* AND/OR between groups */}
                      {groupIndex < filter.groups.length - 1 && (
                        <div className="flex items-center justify-center py-2">
                          <button
                            onClick={toggleRootOperator}
                            className="px-4 py-1.5 text-sm font-bold rounded-full border-2 border-blue-300 dark:border-blue-600
                                       bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300
                                       hover:bg-blue-100 dark:hover:bg-blue-900/50
                                       transition-colors shadow-md"
                            title="Click to toggle between AND/OR (applies between groups)"
                          >
                            {filter.operator}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Add Group */}
              <button
                onClick={addGroup}
                className="w-full px-4 py-2 text-sm font-medium rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600
                           text-gray-600 dark:text-gray-400 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400
                           transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Group
              </button>
            </div>
          ) : viewMode === 'json' ? (
            <div className="space-y-3">
              {jsonError && (
                <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
                  {jsonError}
                </div>
              )}
              <textarea
                value={jsonValue}
                onChange={(e) => setJsonValue(e.target.value)}
                className="w-full h-96 px-3 py-2 text-sm font-mono rounded-lg border border-gray-300 dark:border-gray-600
                           bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
                spellCheck={false}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Edit the JSON directly. Switch back to Visual mode to apply changes.
              </p>
            </div>
          ) : (
            /* Actions View */
            <div className="space-y-6">
              {/* Info Banner */}
              <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div className="text-sm text-blue-900 dark:text-blue-100">
                    <p className="font-medium mb-1">Configure actions to apply to emails matching this filter</p>
                    <p className="text-blue-700 dark:text-blue-300">
                      Actions can move emails to folders and/or modify labels automatically.
                    </p>
                  </div>
                </div>
              </div>

              {/* Action Mode Selection */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Action Mode
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setActionMode('once')}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      actionMode === 'once'
                        ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20'
                        : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        actionMode === 'once'
                          ? 'border-blue-600 dark:border-blue-400'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}>
                        {actionMode === 'once' && (
                          <div className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400" />
                        )}
                      </div>
                      <span className="font-medium text-gray-900 dark:text-gray-100">Run Once</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400 text-left">
                      Apply actions to all matching emails right now, one time only
                    </p>
                  </button>

                  <button
                    onClick={() => {
                      setActionMode('always');
                      // Switch to 'add' mode if currently on 'remove' since remove is invalid for always
                      if (actionLabelMode === 'remove') {
                        setActionLabelMode('add');
                      }
                    }}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      actionMode === 'always'
                        ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20'
                        : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        actionMode === 'always'
                          ? 'border-blue-600 dark:border-blue-400'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}>
                        {actionMode === 'always' && (
                          <div className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400" />
                        )}
                      </div>
                      <span className="font-medium text-gray-900 dark:text-gray-100">Run Always</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400 text-left">
                      Automatically apply actions to new emails as they arrive
                    </p>
                  </button>
                </div>
              </div>

              {/* Move to Folder */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={!!actionFolder}
                    onChange={(e) => setActionFolder(e.target.checked ? 'INBOX' : '')}
                    className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                  />
                  Move to Folder
                </label>
                {actionFolder && (
                  <select
                    value={actionFolder}
                    onChange={(e) => setActionFolder(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                               bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                               focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="INBOX">Inbox</option>
                    <option value="ARCHIVE">Archive</option>
                    <option value="SPAM">Spam</option>
                    <option value="TRASH">Trash</option>
                    {folders
                      .filter(f => !['INBOX', 'ARCHIVE', 'SPAM', 'TRASH'].includes(f.id))
                      .map(folder => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                  </select>
                )}
              </div>

              {/* Modify Labels */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={actionLabelsEnabled}
                    onChange={(e) => setActionLabelsEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                  />
                  Modify Labels
                </label>
                {actionLabelsEnabled && (
                  <div className="space-y-3 pl-6">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setActionLabelMode('add')}
                        className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                          actionLabelMode === 'add'
                            ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/20 dark:text-blue-300'
                            : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                        }`}
                      >
                        Add Labels
                      </button>
                      <button
                        onClick={() => setActionLabelMode('remove')}
                        disabled={actionMode === 'always'}
                        className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                          actionLabelMode === 'remove'
                            ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/20 dark:text-blue-300'
                            : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                        title={actionMode === 'always' ? 'Remove labels is not available for "Run Always" mode' : ''}
                      >
                        Remove Labels
                      </button>
                      <button
                        onClick={() => setActionLabelMode('set')}
                        className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                          actionLabelMode === 'set'
                            ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/20 dark:text-blue-300'
                            : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                        }`}
                      >
                        Set Labels
                      </button>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-xs text-gray-600 dark:text-gray-400">
                        {actionLabelMode === 'add' && 'Labels to add'}
                        {actionLabelMode === 'remove' && 'Labels to remove'}
                        {actionLabelMode === 'set' && 'Set exactly these labels (replaces all existing)'}
                      </label>
                      <select
                        multiple
                        value={actionLabels}
                        onChange={(e) => setActionLabels(Array.from(e.target.selectedOptions, option => option.value))}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600
                                   bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                                   focus:outline-none focus:ring-2 focus:ring-blue-500"
                        size={5}
                      >
                        {labels.map((label) => (
                          <option key={label.id} value={label.id}>
                            {label.name}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Hold Ctrl/Cmd to select multiple labels
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Mark as Read/Unread */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={actionMarkAsRead !== undefined}
                    onChange={(e) => setActionMarkAsRead(e.target.checked ? true : undefined)}
                    className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                  />
                  Mark as Read/Unread
                </label>
                {actionMarkAsRead !== undefined && (
                  <div className="pl-6 flex gap-2">
                    <button
                      onClick={() => setActionMarkAsRead(true)}
                      className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                        actionMarkAsRead === true
                          ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/20 dark:text-blue-300'
                          : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      Mark as Read
                    </button>
                    <button
                      onClick={() => setActionMarkAsRead(false)}
                      className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                        actionMarkAsRead === false
                          ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/20 dark:text-blue-300'
                          : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      Mark as Unread
                    </button>
                  </div>
                )}
              </div>

              {/* Action Button */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                {actionError && (
                  <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800
                                  text-red-700 dark:text-red-300 text-sm">
                    {actionError}
                  </div>
                )}
                <button
                  onClick={handleRunAction}
                  disabled={actionRunning || (!currentFilterName && actionMode == 'always') || (!actionFolder && !actionLabelsEnabled && actionMarkAsRead === undefined)}
                  className="w-full px-4 py-3 text-sm font-medium rounded-lg
                             text-white bg-blue-600 hover:bg-blue-700
                             disabled:opacity-50 disabled:cursor-not-allowed
                             transition-colors flex items-center justify-center gap-2"
                >
                  {actionRunning ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                      </svg>
                      {actionMode === 'once' ? 'Running...' : 'Saving...'}
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      {actionMode === 'once' ? 'Run Action Now' : 'Enable Automatic Actions'}
                    </>
                  )}
                </button>
                {(!currentFilterName && actionMode == 'always') && (
                  <p className="mt-2 text-xs text-center text-gray-500 dark:text-gray-400">
                    Save the filter first to enable actions
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={clearFilters}
            className="px-4 py-2 text-sm font-medium rounded-lg
                       text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700
                       transition-colors"
          >
            Clear All
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg
                         text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700
                         hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg
                         text-white bg-blue-600 hover:bg-blue-700
                         transition-colors"
            >
              Apply Filters
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
