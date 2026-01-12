'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { PdfViewer } from '@/components/takeoff/pdf-viewer';
import { TakeoffToolbar } from '@/components/takeoff/toolbar';
import { TakeoffDataPanel } from '@/components/takeoff/data-panel';
import { TakeoffSheetPanel } from '@/components/takeoff/sheet-panel';
import { useToast } from '@/components/ui/toast';
import {
  useTakeoffStore,
  type TakeoffCategory,
  type TakeoffMeasurement,
  type ScaleCalibration,
} from '@/lib/stores/takeoff-store';

// Generate unique ID
function generateId(): string {
  return crypto.randomUUID();
}

// Quick-start category templates for common trades
const CATEGORY_TEMPLATES: Array<{
  name: string;
  type: 'count' | 'linear' | 'area';
  color: string;
}> = [
  // Electrical - Count
  { name: 'Duplex Outlets', type: 'count', color: '#3b82f6' },
  { name: 'Light Fixtures', type: 'count', color: '#f59e0b' },
  { name: 'Switches', type: 'count', color: '#10b981' },
  { name: 'Junction Boxes', type: 'count', color: '#8b5cf6' },
  // Electrical - Linear
  { name: 'Conduit', type: 'linear', color: '#6366f1' },
  { name: 'Wire Runs', type: 'linear', color: '#ec4899' },
  // Flooring/Finishes - Area
  { name: 'Carpet', type: 'area', color: '#14b8a6' },
  { name: 'Tile', type: 'area', color: '#f97316' },
  { name: 'Paint', type: 'area', color: '#a855f7' },
  // Walls/Partitions - Linear
  { name: 'Drywall', type: 'linear', color: '#64748b' },
  { name: 'Base Trim', type: 'linear', color: '#78716c' },
  // Structural - Count
  { name: 'Columns', type: 'count', color: '#475569' },
  { name: 'Doors', type: 'count', color: '#7c3aed' },
  { name: 'Windows', type: 'count', color: '#0ea5e9' },
];

export default function TakeoffWorkspacePage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { addToast } = useToast();

  const {
    project,
    setProject,
    currentSheetId,
    setCurrentSheet,
    addMeasurement,
    measurements,
    setMeasurements,
    activeCategory,
    setActiveCategory,
    deleteMeasurement,
    setCalibration,
    calibration,
  } = useTakeoffStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaveTime, setLastSaveTime] = useState<Date | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryType, setNewCategoryType] = useState<'count' | 'linear' | 'area'>('count');

  // Edit category state
  const [editingCategory, setEditingCategory] = useState<TakeoffCategory | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [editCategoryColor, setEditCategoryColor] = useState('');
  const measurementsLoadedRef = useRef(false);

  // Add sheets modal state
  const [showAddSheets, setShowAddSheets] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');

  // Sync status tracking
  const [pendingSaves, setPendingSaves] = useState(0);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingSaves > 0 || saving) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [pendingSaves, saving]);

  // Load project data
  useEffect(() => {
    async function loadProject() {
      try {
        setLoading(true);
        const response = await fetch(`/api/takeoff/projects/${projectId}`);
        if (!response.ok) {
          throw new Error('Failed to load project');
        }
        const data = await response.json();
        setProject(data.project);

        // Select first sheet if available
        if (data.project.sheets.length > 0 && !currentSheetId) {
          setCurrentSheet(data.project.sheets[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load project');
      } finally {
        setLoading(false);
      }
    }

    loadProject();
  }, [projectId, setProject, setCurrentSheet, currentSheetId]);

  // Load existing measurements for the project
  useEffect(() => {
    if (!projectId || measurementsLoadedRef.current) return;

    async function loadMeasurements() {
      try {
        const response = await fetch(`/api/takeoff/measurements?projectId=${projectId}`);
        if (response.ok) {
          const data = await response.json();
          // Transform API response to match store format
          const formattedMeasurements: TakeoffMeasurement[] = data.measurements.map((m: {
            id: string;
            sheetId: string;
            categoryId: string;
            type: 'count' | 'linear' | 'area';
            geometry: { type: 'Point' | 'LineString' | 'Polygon'; coordinates: number[] | number[][] | number[][][] };
            quantity: number;
            unit: string;
            label?: string;
            createdAt: string;
          }) => ({
            id: m.id,
            sheetId: m.sheetId,
            categoryId: m.categoryId,
            type: m.type,
            geometry: m.geometry,
            quantity: m.quantity,
            unit: m.unit,
            label: m.label,
            createdAt: new Date(m.createdAt),
          }));
          setMeasurements(formattedMeasurements);
          measurementsLoadedRef.current = true;
        }
      } catch (err) {
        console.error('Failed to load measurements:', err);
      }
    }

    loadMeasurements();
  }, [projectId, setMeasurements]);

  // Get current sheet
  const currentSheet = project?.sheets.find((s) => s.id === currentSheetId);

  // Load calibration when sheet changes
  useEffect(() => {
    if (!currentSheetId) {
      setCalibration(null);
      return;
    }

    async function loadCalibration() {
      try {
        const response = await fetch(`/api/takeoff/sheets/${currentSheetId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.sheet?.calibration) {
            setCalibration(data.sheet.calibration as ScaleCalibration);
          } else {
            setCalibration(null);
          }
        }
      } catch (err) {
        console.error('Failed to load calibration:', err);
      }
    }

    loadCalibration();
  }, [currentSheetId, setCalibration]);

  // Handle measurement completion
  const handleMeasurementComplete = useCallback(
    async (measurement: Omit<TakeoffMeasurement, 'id' | 'createdAt'>) => {
      const newMeasurement: TakeoffMeasurement = {
        ...measurement,
        id: generateId(),
        createdAt: new Date(),
      };

      // Add to local state optimistically
      addMeasurement(newMeasurement);
      setSaving(true);
      setLastSaveTime(null);

      // Save to server
      try {
        const response = await fetch(`/api/takeoff/measurements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...newMeasurement,
            projectId,
          }),
        });
        if (!response.ok) {
          throw new Error('Failed to save');
        }
        setLastSaveTime(new Date());
        setLastSyncError(null);
      } catch (err) {
        console.error('Failed to save measurement:', err);
        // Remove from local state on failure
        deleteMeasurement(newMeasurement.id);
        setLastSyncError('Failed to save measurement');
        // Show error toast with retry option
        addToast({
          type: 'error',
          message: 'Failed to save measurement',
          action: {
            label: 'Retry',
            onClick: () => handleMeasurementComplete(measurement),
          },
          duration: 5000,
        });
      } finally {
        setSaving(false);
      }
    },
    [addMeasurement, deleteMeasurement, projectId, addToast]
  );

  // Handle adding a category (reusable for both custom and template)
  const createCategory = async (name: string, type: 'count' | 'linear' | 'area', color?: string) => {
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    const newCategory: TakeoffCategory = {
      id: generateId(),
      projectId,
      name,
      color: color || colors[(project?.categories.length || 0) % colors.length],
      measurementType: type,
      sortOrder: (project?.categories.length || 0) + 1,
    };

    // Update local state
    if (project) {
      setProject({
        ...project,
        categories: [...project.categories, newCategory],
      });
    }

    // Auto-select new category
    setActiveCategory(newCategory);

    // Save to server
    try {
      await fetch(`/api/takeoff/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCategory),
      });
    } catch (err) {
      console.error('Failed to save category:', err);
    }

    return newCategory;
  };

  // Handle adding a custom category
  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) return;
    await createCategory(newCategoryName.trim(), newCategoryType);
    setNewCategoryName('');
    setShowAddCategory(false);
  };

  // Handle adding from template
  const handleAddFromTemplate = async (template: typeof CATEGORY_TEMPLATES[0]) => {
    await createCategory(template.name, template.type, template.color);
    setShowAddCategory(false);
  };

  // Filter templates to show only ones not already added
  const availableTemplates = CATEGORY_TEMPLATES.filter(
    (t) => !project?.categories.some((c) => c.name.toLowerCase() === t.name.toLowerCase())
  );

  // Handle starting category edit
  const handleStartEditCategory = (category: TakeoffCategory) => {
    setEditingCategory(category);
    setEditCategoryName(category.name);
    setEditCategoryColor(category.color);
  };

  // Handle saving category edit
  const handleSaveEditCategory = async () => {
    if (!project || !editingCategory || !editCategoryName.trim()) return;

    const updates = {
      name: editCategoryName.trim(),
      color: editCategoryColor,
    };

    // Update local state
    setProject({
      ...project,
      categories: project.categories.map((c) =>
        c.id === editingCategory.id ? { ...c, ...updates } : c
      ),
    });

    // Update active category if it's the one being edited
    if (activeCategory?.id === editingCategory.id) {
      setActiveCategory({ ...activeCategory, ...updates });
    }

    // Save to server
    try {
      await fetch('/api/takeoff/categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingCategory.id, ...updates }),
      });
    } catch (err) {
      console.error('Failed to update category:', err);
    }

    setEditingCategory(null);
  };

  // Handle adding more sheets to existing project
  const handleUploadSheets = async () => {
    if (uploadFiles.length === 0) return;

    setUploading(true);
    try {
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i];
        setUploadProgress(`Uploading ${file.name} (${i + 1}/${uploadFiles.length})...`);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('projectId', projectId);

        const response = await fetch('/api/takeoff/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || `Failed to upload ${file.name}`);
        }

        const data = await response.json();

        // Add new sheets to project state
        if (project && data.sheets) {
          setProject({
            ...project,
            sheets: [...project.sheets, ...data.sheets],
          });
        }
      }

      setShowAddSheets(false);
      setUploadFiles([]);
      setUploadProgress('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setTimeout(() => setError(null), 5000);
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-muted-foreground">Loading project...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center text-destructive">
          <p className="text-xl mb-2">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <p className="text-muted-foreground">Project not found</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-secondary">
      {/* Top bar */}
      <div className="bg-card border-b border-border px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href="/takeoff" className="text-primary hover:underline text-sm transition-smooth">
            ← Projects
          </a>
          <h1 className="font-serif font-semibold text-foreground">{project.name}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {currentSheet && <span>Sheet: {currentSheet.name}</span>}
          <span>•</span>
          <span>{measurements.length} measurements</span>
          {/* Sync status indicator */}
          {saving ? (
            <span className="flex items-center gap-1 text-primary">
              <span className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              Saving...
            </span>
          ) : lastSyncError ? (
            <span className="flex items-center gap-1 text-destructive" title={lastSyncError}>
              <span className="w-2 h-2 bg-destructive rounded-full" />
              Sync error
            </span>
          ) : lastSaveTime ? (
            <span className="flex items-center gap-1 text-sage" title={`Last saved ${lastSaveTime.toLocaleTimeString()}`}>
              <span className="w-2 h-2 bg-sage rounded-full" />
              Saved
            </span>
          ) : null}
        </div>
      </div>

      {/* Main workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Sheet panel */}
        <TakeoffSheetPanel onAddSheets={() => setShowAddSheets(true)} />

        {/* Center: PDF viewer with toolbar */}
        <div className="flex-1 relative">
          {/* Floating toolbar */}
          <div className="absolute top-4 left-4 z-10">
            <TakeoffToolbar />
          </div>

          {/* First-time user onboarding */}
          {currentSheet && project.categories.length === 0 && measurements.length === 0 && (
            <div className="absolute inset-0 bg-charcoal/30 flex items-center justify-center z-20">
              <div className="bg-card rounded-xl shadow-2xl p-8 max-w-md text-center border border-border">
                <div className="text-5xl mb-4">👋</div>
                <h2 className="text-xl font-serif font-bold text-foreground mb-2">Welcome to Takeoff!</h2>
                <p className="text-muted-foreground mb-6">
                  Get started by creating your first measurement category. Categories help you organize
                  different types of items like outlets, conduit, or flooring.
                </p>
                <div className="space-y-3">
                  <button
                    onClick={() => setShowAddCategory(true)}
                    className="w-full px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 font-medium btn-lift"
                  >
                    Create Your First Category
                  </button>
                  <p className="text-xs text-muted-foreground">
                    Tip: Press <kbd className="px-1.5 py-0.5 bg-secondary rounded text-foreground">K</kbd> to calibrate scale,{' '}
                    <kbd className="px-1.5 py-0.5 bg-secondary rounded text-foreground">?</kbd> for all shortcuts
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Warning banner for missing requirements (after onboarding) */}
          {currentSheet && project.categories.length > 0 && (!activeCategory || !calibration) && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex gap-2">
              {!activeCategory && (
                <div className="bg-terracotta/10 border border-terracotta/30 text-terracotta px-3 py-1.5 rounded-lg text-sm shadow-sm flex items-center gap-2">
                  <span>Select a category to start measuring</span>
                  <button
                    onClick={() => setShowAddCategory(true)}
                    className="text-terracotta hover:text-terracotta/80 underline font-medium"
                  >
                    Add category
                  </button>
                </div>
              )}
              {!calibration && (
                <div className="bg-primary/10 border border-primary/30 text-primary px-3 py-1.5 rounded-lg text-sm shadow-sm flex items-center gap-2">
                  <span>Set scale for accurate measurements</span>
                  <span className="text-primary/70">(Press K)</span>
                </div>
              )}
            </div>
          )}

          {/* PDF Viewer */}
          {currentSheet ? (
            <PdfViewer
              sheetId={currentSheet.id}
              tileUrlTemplate={currentSheet.tileUrlTemplate || undefined}
              width={currentSheet.widthPx}
              height={currentSheet.heightPx}
              onMeasurementComplete={handleMeasurementComplete}
            />
          ) : (
            <div className="flex items-center justify-center h-full bg-secondary">
              <div className="text-center text-muted-foreground">
                <p className="text-lg">Select a sheet to start</p>
                <p className="text-sm mt-1">Choose from the sheet panel on the left</p>
              </div>
            </div>
          )}
        </div>

        {/* Right: Data panel */}
        <TakeoffDataPanel
          projectName={project.name}
          projectId={projectId}
          onAddCategory={() => setShowAddCategory(true)}
          onEditCategory={handleStartEditCategory}
        />
      </div>

      {/* Add Category Modal */}
      {showAddCategory && (
        <div className="fixed inset-0 bg-charcoal/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-lg p-6 w-[480px] max-h-[90vh] overflow-y-auto border border-border shadow-lg">
            <h2 className="text-lg font-serif font-semibold mb-4 text-foreground">Add Category</h2>

            {/* Quick-start templates */}
            {availableTemplates.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-3">QUICK ADD</h3>
                <div className="flex flex-wrap gap-2">
                  {availableTemplates.slice(0, 8).map((template) => (
                    <button
                      key={template.name}
                      onClick={() => handleAddFromTemplate(template)}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-full hover:bg-secondary transition-smooth"
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: template.color }}
                      />
                      <span>{template.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {template.type === 'count' ? 'EA' : template.type === 'linear' ? 'LF' : 'SF'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Divider */}
            {availableTemplates.length > 0 && (
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">or create custom</span>
                <div className="flex-1 h-px bg-border" />
              </div>
            )}

            {/* Custom category form */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="e.g., Fire Alarm Devices"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input focus:ring-2 focus:ring-primary"
                  autoFocus={availableTemplates.length === 0}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Measurement Type
                </label>
                <select
                  value={newCategoryType}
                  onChange={(e) => setNewCategoryType(e.target.value as 'count' | 'linear' | 'area')}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input"
                >
                  <option value="count">Count (EA) - for individual items</option>
                  <option value="linear">Linear (LF) - for lengths</option>
                  <option value="area">Area (SF) - for surfaces</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowAddCategory(false)}
                className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-smooth"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCategory}
                disabled={!newCategoryName.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 btn-lift"
              >
                Add Category
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Sheets Modal */}
      {showAddSheets && (
        <div className="fixed inset-0 bg-charcoal/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-lg p-6 w-[500px] max-h-[90vh] overflow-y-auto border border-border shadow-lg">
            <h2 className="text-lg font-serif font-semibold mb-4 text-foreground">Add More Sheets</h2>

            {/* Drag and drop zone */}
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-smooth ${
                uploading ? 'border-border bg-secondary' : 'border-border hover:border-primary'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('border-primary', 'bg-primary/5');
              }}
              onDragLeave={(e) => {
                e.currentTarget.classList.remove('border-primary', 'bg-primary/5');
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-primary', 'bg-primary/5');
                const files = Array.from(e.dataTransfer.files).filter(
                  (f) => f.type === 'application/pdf'
                );
                setUploadFiles((prev) => [...prev, ...files]);
              }}
            >
              <input
                type="file"
                accept=".pdf,application/pdf"
                multiple
                onChange={(e) => {
                  if (e.target.files) {
                    const files = Array.from(e.target.files).filter(
                      (f) => f.type === 'application/pdf'
                    );
                    setUploadFiles((prev) => [...prev, ...files]);
                  }
                }}
                className="hidden"
                id="add-sheets-upload"
                disabled={uploading}
              />
              <label htmlFor="add-sheets-upload" className="cursor-pointer block">
                <div className="text-4xl mb-2">📄</div>
                <p className="text-muted-foreground">
                  Drag & drop PDF files here, or click to browse
                </p>
                <p className="text-sm text-muted-foreground/70 mt-1">
                  Each page becomes a new sheet
                </p>
              </label>
            </div>

            {/* Selected files */}
            {uploadFiles.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {uploadFiles.length} file{uploadFiles.length > 1 ? 's' : ''} selected:
                </p>
                {uploadFiles.map((file, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 bg-secondary rounded"
                  >
                    <span className="text-sm text-foreground truncate flex-1">{file.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </span>
                      <button
                        onClick={() => setUploadFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-destructive/60 hover:text-destructive p-1 transition-smooth"
                        disabled={uploading}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Upload progress */}
            {uploading && uploadProgress && (
              <div className="mt-4 p-3 bg-primary/10 border border-primary/30 rounded-lg">
                <div className="flex items-center gap-2">
                  <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />
                  <span className="text-sm text-primary">{uploadProgress}</span>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowAddSheets(false);
                  setUploadFiles([]);
                }}
                className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-smooth"
                disabled={uploading}
              >
                Cancel
              </button>
              <button
                onClick={handleUploadSheets}
                disabled={uploading || uploadFiles.length === 0}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 btn-lift"
              >
                {uploading ? 'Uploading...' : `Add ${uploadFiles.length || ''} Sheet${uploadFiles.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Category Modal */}
      {editingCategory && (
        <div className="fixed inset-0 bg-charcoal/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-lg p-6 w-[400px] border border-border shadow-lg">
            <h2 className="text-lg font-serif font-semibold mb-4 text-foreground">Edit Category</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={editCategoryName}
                  onChange={(e) => setEditCategoryName(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input focus:ring-2 focus:ring-primary"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Color
                </label>
                <div className="flex flex-wrap gap-2">
                  {['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#6366f1'].map((color) => (
                    <button
                      key={color}
                      onClick={() => setEditCategoryColor(color)}
                      className={`w-8 h-8 rounded-full transition-all ${
                        editCategoryColor === color ? 'ring-2 ring-offset-2 ring-border scale-110' : 'hover:scale-105'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                {/* Custom color input */}
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="color"
                    value={editCategoryColor}
                    onChange={(e) => setEditCategoryColor(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer"
                  />
                  <span className="text-sm text-muted-foreground">Custom color</span>
                </div>
              </div>

              <div className="text-sm text-muted-foreground bg-secondary rounded p-2">
                Type: {editingCategory.measurementType === 'count' ? 'Count (EA)' : editingCategory.measurementType === 'linear' ? 'Linear (LF)' : 'Area (SF)'}
                <span className="ml-1 text-muted-foreground/70">(cannot be changed)</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setEditingCategory(null)}
                className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-smooth"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditCategory}
                disabled={!editCategoryName.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 btn-lift"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
