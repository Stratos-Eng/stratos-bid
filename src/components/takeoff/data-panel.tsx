'use client';

import { useMemo, useState, useCallback } from 'react';
import { useTakeoffStore, type TakeoffCategory, type TakeoffMeasurement } from '@/lib/stores/takeoff-store';
import { useToast } from '@/components/ui/toast';

interface DataPanelProps {
  projectName: string;
  projectId?: string;
  onExport?: () => void;
  onAddCategory?: () => void;
  onEditCategory?: (category: TakeoffCategory) => void;
}

export function TakeoffDataPanel({ projectName, projectId, onAddCategory, onEditCategory }: DataPanelProps) {
  const {
    project,
    measurements,
    activeCategory,
    setActiveCategory,
    selectedMeasurementIds,
    selectMeasurement,
    deleteMeasurement,
    clearSelection,
    calibration,
    panToMeasurement,
    updateMeasurement,
    undo,
  } = useTakeoffStore();

  const { addToast } = useToast();

  // Delete with undo toast
  const handleDelete = useCallback((id: string) => {
    deleteMeasurement(id);
    addToast({
      type: 'info',
      message: 'Measurement deleted',
      action: {
        label: 'Undo',
        onClick: () => undo(),
      },
      duration: 5000,
    });
  }, [deleteMeasurement, addToast, undo]);

  // Bulk delete with undo feedback
  const handleBulkDelete = useCallback(() => {
    const count = selectedMeasurementIds.length;
    if (confirm(`Delete ${count} measurements?`)) {
      selectedMeasurementIds.forEach((id) => deleteMeasurement(id));
      clearSelection();
      addToast({
        type: 'info',
        message: `${count} measurements deleted`,
        action: {
          label: 'Undo',
          onClick: () => {
            // Undo all deletions
            for (let i = 0; i < count; i++) {
              undo();
            }
          },
        },
        duration: 5000,
      });
    }
  }, [selectedMeasurementIds, deleteMeasurement, clearSelection, addToast, undo]);

  const [searchQuery, setSearchQuery] = useState('');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [movingMeasurementId, setMovingMeasurementId] = useState<string | null>(null);
  const [showBulkMoveMenu, setShowBulkMoveMenu] = useState(false);
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv'>('excel');

  const categories = project?.categories || [];

  // Virtual "Uncategorized" category for measurements without a category
  const UNCATEGORIZED_CATEGORY: TakeoffCategory = {
    id: 'uncategorized',
    projectId: project?.id || '',
    name: 'Uncategorized',
    color: '#9ca3af',
    measurementType: 'count', // Default, but we'll show mixed
    sortOrder: 9999,
  };

  // Group measurements by category
  const measurementsByCategory = useMemo(() => {
    const grouped = new Map<string, TakeoffMeasurement[]>();
    measurements.forEach((m) => {
      const existing = grouped.get(m.categoryId) || [];
      existing.push(m);
      grouped.set(m.categoryId, existing);
    });
    return grouped;
  }, [measurements]);

  // Filter measurements by search query
  const filteredMeasurements = useMemo(() => {
    if (!searchQuery.trim()) return measurements;

    const query = searchQuery.toLowerCase();
    return measurements.filter((m) => {
      // Search by label
      if (m.label?.toLowerCase().includes(query)) return true;

      // Search by ID prefix
      if (m.id.toLowerCase().includes(query)) return true;

      // Search by category name
      const category = categories.find((c) => c.id === m.categoryId);
      if (category?.name.toLowerCase().includes(query)) return true;

      return false;
    });
  }, [measurements, searchQuery, categories]);

  // Group filtered measurements by category
  const filteredByCategory = useMemo(() => {
    const grouped = new Map<string, TakeoffMeasurement[]>();
    filteredMeasurements.forEach((m) => {
      const existing = grouped.get(m.categoryId) || [];
      existing.push(m);
      grouped.set(m.categoryId, existing);
    });
    return grouped;
  }, [filteredMeasurements]);

  // Check if we have uncategorized measurements
  const uncategorizedMeasurements = measurementsByCategory.get('uncategorized') || [];
  const hasUncategorized = uncategorizedMeasurements.length > 0;

  // Categories including virtual uncategorized if needed
  const allCategories = useMemo(() => {
    if (hasUncategorized) {
      return [...categories, UNCATEGORIZED_CATEGORY];
    }
    return categories;
  }, [categories, hasUncategorized]);

  // Calculate totals per category
  const categoryTotals = useMemo(() => {
    const totals = new Map<string, { count: number; total: number; unit: string }>();

    allCategories.forEach((cat) => {
      const catMeasurements = measurementsByCategory.get(cat.id) || [];
      const total = catMeasurements.reduce((sum, m) => sum + m.quantity, 0);
      totals.set(cat.id, {
        count: catMeasurements.length,
        total,
        unit: cat.measurementType === 'count' ? 'EA' : cat.measurementType === 'linear' ? 'LF' : 'SF',
      });
    });

    return totals;
  }, [allCategories, measurementsByCategory]);

  // Format quantity for display
  const formatQuantity = (value: number, type: string): string => {
    if (type === 'count') return Math.round(value).toLocaleString();
    return value.toFixed(2);
  };

  // Toggle category expansion
  const toggleExpanded = (categoryId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  // Auto-expand when search active
  const isExpanded = (categoryId: string) => {
    if (searchQuery.trim()) return true; // Expand all when searching
    if (activeCategory?.id === categoryId) return true; // Expand active category
    return expandedCategories.has(categoryId);
  };

  // Filter categories that have matching measurements when searching
  const visibleCategories = useMemo(() => {
    if (!searchQuery.trim()) return allCategories;
    return allCategories.filter((cat) => {
      const matches = filteredByCategory.get(cat.id);
      return matches && matches.length > 0;
    });
  }, [allCategories, searchQuery, filteredByCategory]);

  return (
    <div className="w-80 bg-card border-l border-border flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex justify-between items-center">
          <h2 className="font-serif font-semibold text-foreground truncate">{projectName}</h2>
          {projectId && (
            <div className="relative">
              <button
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="px-3 py-1 text-sm bg-sage text-white rounded hover:bg-sage/90 flex items-center gap-1 transition-smooth"
              >
                Export
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showExportMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowExportMenu(false)}
                  />
                  <div className="absolute right-0 mt-1 w-40 bg-card border border-border rounded-lg shadow-lg z-20">
                    <button
                      onClick={() => {
                        setExportFormat('excel');
                        setShowExportConfirm(true);
                        setShowExportMenu(false);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-secondary flex items-center gap-2"
                    >
                      <span className="text-sage">📊</span>
                      Excel (.xlsx)
                    </button>
                    <button
                      onClick={() => {
                        setExportFormat('csv');
                        setShowExportConfirm(true);
                        setShowExportMenu(false);
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-secondary flex items-center gap-2 border-t border-border"
                    >
                      <span className="text-muted-foreground">📄</span>
                      CSV (.csv)
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Scale indicator */}
        {calibration && (
          <div className="mt-2 text-xs text-muted-foreground bg-secondary rounded px-2 py-1">
            Scale: 1 {calibration.unit} = {calibration.pixelsPerUnit.toFixed(1)} px
          </div>
        )}
      </div>

      {/* Search and Add */}
      <div className="p-3 border-b border-border flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-border rounded-lg pr-8 bg-input focus:ring-2 focus:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          )}
        </div>
        {onAddCategory && (
          <button
            onClick={onAddCategory}
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-secondary transition-smooth"
          >
            + Category
          </button>
        )}
      </div>

      {/* Search results info */}
      {searchQuery && (
        <div className="px-3 py-2 text-xs text-muted-foreground bg-sandstone border-b border-border">
          Found {filteredMeasurements.length} item{filteredMeasurements.length !== 1 ? 's' : ''}{' '}
          in {visibleCategories.length} categor{visibleCategories.length !== 1 ? 'ies' : 'y'}
        </div>
      )}

      {/* Multi-select action bar */}
      {selectedMeasurementIds.length > 1 && (
        <div className="px-3 py-2 text-sm bg-primary/10 border-b border-border flex items-center justify-between">
          <span className="text-primary">
            {selectedMeasurementIds.length} items selected
          </span>
          <div className="flex items-center gap-2">
            {/* Bulk move to category */}
            <div className="relative">
              <button
                onClick={() => setShowBulkMoveMenu(!showBulkMoveMenu)}
                className="text-primary hover:text-primary/80 text-xs px-2 py-1 rounded hover:bg-primary/10 flex items-center gap-1 transition-smooth"
              >
                Move to
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showBulkMoveMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowBulkMoveMenu(false)}
                  />
                  <div className="absolute right-0 mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-20 max-h-60 overflow-y-auto">
                    {categories.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => {
                          selectedMeasurementIds.forEach((id) => {
                            const m = measurements.find(m => m.id === id);
                            // Only move if measurement type matches category type
                            if (m && m.type === cat.measurementType) {
                              updateMeasurement(id, { categoryId: cat.id });
                            }
                          });
                          setShowBulkMoveMenu(false);
                          clearSelection();
                        }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-secondary flex items-center gap-2"
                      >
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: cat.color }}
                        />
                        <span className="truncate">{cat.name}</span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {cat.measurementType === 'count' ? 'EA' : cat.measurementType === 'linear' ? 'LF' : 'SF'}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={clearSelection}
              className="text-muted-foreground hover:text-foreground text-xs px-2 py-1 rounded hover:bg-primary/10 transition-smooth"
            >
              Clear
            </button>
            <button
              onClick={handleBulkDelete}
              className="text-destructive hover:text-destructive/80 text-xs px-2 py-1 rounded hover:bg-destructive/10 transition-smooth"
            >
              Delete All
            </button>
          </div>
        </div>
      )}

      {/* Categories list */}
      <div className="flex-1 overflow-y-auto">
        {allCategories.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <p>No categories yet</p>
            <p className="mt-1">Start measuring or add a category</p>
          </div>
        ) : visibleCategories.length === 0 && searchQuery ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <p>No matching items found</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visibleCategories.map((category) => {
              const totals = categoryTotals.get(category.id);
              const catMeasurements = searchQuery
                ? filteredByCategory.get(category.id) || []
                : measurementsByCategory.get(category.id) || [];
              const isActive = activeCategory?.id === category.id;
              const expanded = isExpanded(category.id);

              return (
                <div key={category.id} className="p-3">
                  {/* Category header */}
                  <div
                    className={`w-full flex items-center justify-between p-2 rounded-lg transition-smooth cursor-pointer group ${
                      isActive ? 'bg-primary/10 border border-primary/30' : 'hover:bg-secondary'
                    }`}
                  >
                    <button
                      onClick={() => toggleExpanded(category.id)}
                      className="flex items-center gap-2 flex-1"
                    >
                      <span className="text-muted-foreground text-xs">
                        {expanded ? '▼' : '▶'}
                      </span>
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      <span className="font-medium text-foreground">{category.name}</span>
                      <span className="text-xs text-muted-foreground">({catMeasurements.length})</span>
                    </button>
                    <div className="flex items-center gap-1">
                      {/* Edit button - only for real categories */}
                      {category.id !== 'uncategorized' && onEditCategory && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditCategory(category);
                          }}
                          className="p-1 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Edit category"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => setActiveCategory(isActive ? null : category)}
                        className="text-right pl-1"
                        title={isActive ? 'Deselect category' : 'Select category for drawing'}
                      >
                        <span className="text-lg font-semibold text-foreground">
                          {totals ? formatQuantity(totals.total, category.measurementType) : 0}
                        </span>
                        <span className="text-sm text-muted-foreground ml-1">{totals?.unit}</span>
                      </button>
                    </div>
                  </div>

                  {/* Measurements list */}
                  {expanded && catMeasurements.length > 0 && (
                    <div className="mt-2 ml-5 space-y-1 max-h-60 overflow-y-auto">
                      {catMeasurements.map((m) => {
                        const isSelected = selectedMeasurementIds.includes(m.id);
                        return (
                          <div
                            key={m.id}
                            onClick={(e) => {
                              // Multi-select with Shift or Cmd/Ctrl
                              const addToSelection = e.shiftKey || e.metaKey || e.ctrlKey;
                              selectMeasurement(m.id, addToSelection);
                              // Pan to the measurement if available
                              if (panToMeasurement) {
                                panToMeasurement(m.id);
                              }
                            }}
                            className={`flex items-center justify-between p-2 rounded text-sm cursor-pointer transition-smooth ${
                              isSelected ? 'bg-accent/20 border border-accent/40' : 'hover:bg-secondary'
                            }`}
                          >
                            {editingLabelId === m.id ? (
                              <input
                                type="text"
                                value={editLabel}
                                onChange={(e) => setEditLabel(e.target.value)}
                                onBlur={() => {
                                  if (editLabel.trim()) {
                                    updateMeasurement(m.id, { label: editLabel.trim() });
                                  }
                                  setEditingLabelId(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    if (editLabel.trim()) {
                                      updateMeasurement(m.id, { label: editLabel.trim() });
                                    }
                                    setEditingLabelId(null);
                                  }
                                  if (e.key === 'Escape') {
                                    setEditingLabelId(null);
                                  }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="flex-1 px-1 py-0.5 text-sm border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                                autoFocus
                              />
                            ) : (
                              <span
                                className="text-muted-foreground truncate flex-1 cursor-text"
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  setEditingLabelId(m.id);
                                  setEditLabel(m.label || '');
                                }}
                                title="Double-click to rename"
                              >
                                {m.label || `Item ${m.id.slice(0, 8)}`}
                              </span>
                            )}
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-foreground mr-1">
                                {formatQuantity(m.quantity, category.measurementType)} {m.unit}
                              </span>
                              {/* Move to category dropdown */}
                              {movingMeasurementId === m.id ? (
                                <select
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    const newCategoryId = e.target.value;
                                    if (newCategoryId && newCategoryId !== m.categoryId) {
                                      updateMeasurement(m.id, { categoryId: newCategoryId });
                                    }
                                    setMovingMeasurementId(null);
                                  }}
                                  onBlur={() => setMovingMeasurementId(null)}
                                  className="text-xs border border-border rounded px-1 py-0.5 bg-card"
                                  autoFocus
                                  defaultValue=""
                                >
                                  <option value="" disabled>Move to...</option>
                                  {categories
                                    .filter(c => c.id !== category.id && c.measurementType === m.type)
                                    .map(c => (
                                      <option key={c.id} value={c.id}>{c.name}</option>
                                    ))
                                  }
                                </select>
                              ) : (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMovingMeasurementId(m.id);
                                  }}
                                  className="text-muted-foreground hover:text-primary p-1 text-xs transition-smooth"
                                  title="Move to different category"
                                >
                                  ↔
                                </button>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(m.id);
                                }}
                                className="text-destructive/60 hover:text-destructive p-1 transition-smooth"
                                title="Delete (Undo available)"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {expanded && catMeasurements.length === 0 && !searchQuery && (
                    <p className="mt-2 ml-5 text-sm text-muted-foreground">
                      No measurements yet. Start drawing!
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Export Confirmation Modal */}
      {showExportConfirm && projectId && (
        <div className="fixed inset-0 bg-charcoal/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-lg p-6 w-[450px] max-h-[90vh] overflow-y-auto border border-border shadow-lg">
            <h2 className="text-lg font-serif font-semibold mb-4 text-foreground">Export Takeoff</h2>

            {/* Completion status */}
            <div className="mb-4 p-4 bg-secondary rounded-lg">
              <h3 className="text-sm font-medium text-foreground mb-3">Takeoff Summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Categories:</span>
                  <span className={categories.length > 0 ? 'text-sage' : 'text-terracotta'}>
                    {categories.length} {categories.length === 0 && '(none created)'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Measurements:</span>
                  <span className={measurements.length > 0 ? 'text-sage' : 'text-terracotta'}>
                    {measurements.length} {measurements.length === 0 && '(none added)'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Scale Calibrated:</span>
                  <span className={calibration ? 'text-sage' : 'text-terracotta'}>
                    {calibration ? `Yes (${calibration.unit})` : 'No (using pixels)'}
                  </span>
                </div>
              </div>
            </div>

            {/* Warnings */}
            {(measurements.length === 0 || !calibration) && (
              <div className="mb-4 p-3 bg-terracotta/10 border border-terracotta/30 rounded-lg text-terracotta text-sm">
                {measurements.length === 0 && (
                  <p>No measurements to export. Add some measurements first.</p>
                )}
                {!calibration && measurements.length > 0 && (
                  <p>Scale not calibrated. Measurements will be exported in pixel units.</p>
                )}
              </div>
            )}

            {/* Export format */}
            <div className="mb-4">
              <h3 className="text-sm font-medium text-foreground mb-2">Format</h3>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={exportFormat === 'excel'}
                    onChange={() => setExportFormat('excel')}
                    className="text-primary accent-primary"
                  />
                  <span className="text-sm text-foreground">Excel (.xlsx)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={exportFormat === 'csv'}
                    onChange={() => setExportFormat('csv')}
                    className="text-primary accent-primary"
                  />
                  <span className="text-sm text-foreground">CSV (.csv)</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowExportConfirm(false)}
                className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-smooth"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  window.location.href = `/api/takeoff/export?projectId=${projectId}&format=${exportFormat}`;
                  setShowExportConfirm(false);
                }}
                disabled={measurements.length === 0}
                className="px-4 py-2 bg-sage text-white rounded-lg hover:bg-sage/90 disabled:opacity-50 disabled:cursor-not-allowed btn-lift"
              >
                Export {exportFormat === 'excel' ? 'Excel' : 'CSV'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Totals footer */}
      <div className="p-4 border-t border-border bg-secondary">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">TOTALS</h3>
        <div className="space-y-1 text-sm">
          {(['count', 'linear', 'area'] as const).map((type) => {
            // For regular categories, filter by type. For uncategorized, sum by measurement type.
            const typeCategories = allCategories.filter((c) =>
              c.id === 'uncategorized' ? true : c.measurementType === type
            );
            if (typeCategories.length === 0) return null;

            const total = typeCategories.reduce((sum, cat) => {
              if (cat.id === 'uncategorized') {
                // For uncategorized, only sum measurements of this type
                const catMeasurements = measurementsByCategory.get(cat.id) || [];
                return sum + catMeasurements
                  .filter(m => m.type === type)
                  .reduce((mSum, m) => mSum + m.quantity, 0);
              }
              return sum + (categoryTotals.get(cat.id)?.total || 0);
            }, 0);

            if (total === 0) return null;

            const unit = type === 'count' ? 'EA' : type === 'linear' ? 'LF' : 'SF';

            return (
              <div key={type} className="flex justify-between">
                <span className="text-muted-foreground capitalize">{type} items:</span>
                <span className="font-medium text-foreground">
                  {formatQuantity(total, type)} {unit}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
