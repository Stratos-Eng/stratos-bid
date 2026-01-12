'use client';

import { useTakeoffStore, type MeasurementTool, TAKEOFF_SHORTCUTS } from '@/lib/stores/takeoff-store';
import { useToast } from '@/components/ui/toast';
import { useEffect, useState, useCallback } from 'react';

// Keyboard shortcuts help modal
function ShortcutsHelpModal({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { category: 'Tools', items: [
      { key: 'V', desc: 'Select tool' },
      { key: 'C', desc: 'Count tool' },
      { key: 'L', desc: 'Linear measurement' },
      { key: 'A', desc: 'Area measurement' },
      { key: 'R', desc: 'Rectangle area' },
      { key: 'K', desc: 'Calibrate scale' },
    ]},
    { category: 'Navigation', items: [
      { key: '+/-', desc: 'Zoom in/out' },
      { key: 'Home', desc: 'Fit to view' },
      { key: 'Scroll', desc: 'Pan' },
    ]},
    { category: 'Editing', items: [
      { key: 'Del', desc: 'Delete selected' },
      { key: 'Ctrl+Z', desc: 'Undo' },
      { key: 'Ctrl+Y', desc: 'Redo' },
      { key: 'Esc', desc: 'Cancel/Deselect' },
    ]},
    { category: 'Toggles', items: [
      { key: 'S', desc: 'Toggle snapping' },
      { key: 'G', desc: 'Toggle grid' },
      { key: '?', desc: 'Show this help' },
    ]},
    { category: 'Drawing Modifiers', items: [
      { key: 'Alt', desc: 'Disable snap temporarily' },
      { key: 'Shift', desc: 'Constrain to square/45°' },
    ]},
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl p-6 w-[500px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {shortcuts.map(({ category, items }) => (
            <div key={category} className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{category}</h3>
              <div className="space-y-1">
                {items.map(({ key, desc }) => (
                  <div key={key} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{desc}</span>
                    <kbd className="px-2 py-0.5 bg-gray-100 border rounded text-xs font-mono">{key}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t text-center text-xs text-gray-400">
          Press <kbd className="px-1 bg-gray-100 border rounded">?</kbd> anytime to toggle this help
        </div>
      </div>
    </div>
  );
}

const tools: Array<{
  id: MeasurementTool;
  icon: string;
  label: string;
  shortcut: string;
  measurementType?: 'count' | 'linear' | 'area'; // Which category type this tool creates
}> = [
  { id: 'select', icon: '➤', label: 'Select', shortcut: 'V' },
  { id: 'count', icon: '●', label: 'Count', shortcut: 'C', measurementType: 'count' },
  { id: 'line', icon: '—', label: 'Line (2-point)', shortcut: 'I', measurementType: 'linear' },
  { id: 'linear', icon: '/', label: 'Polyline', shortcut: 'L', measurementType: 'linear' },
  { id: 'area', icon: '▭', label: 'Area', shortcut: 'A', measurementType: 'area' },
  { id: 'rectangle', icon: '□', label: 'Rectangle', shortcut: 'R', measurementType: 'area' },
];

// Scale calibration dialog component
function CalibrationDialog({
  mode,
  pixelLength,
  pendingLength,
  pendingUnit,
  onConfirm,
  onCancel,
  onStartDrawing,
  sheetCount = 1,
}: {
  mode: 'input' | 'drawing' | 'confirm';
  pixelLength?: number;
  pendingLength?: number;
  pendingUnit?: 'ft' | 'm';
  onConfirm: (length: number, unit: 'ft' | 'm', applyToAll: boolean) => void;
  onCancel: () => void;
  onStartDrawing: (length: number, unit: 'ft' | 'm') => void;
  sheetCount?: number;
}) {
  const [length, setLength] = useState(pendingLength?.toString() || '');
  const [unit, setUnit] = useState<'ft' | 'm'>(pendingUnit || 'ft');
  const [applyToAll, setApplyToAll] = useState(false);

  const handleStartDrawing = (e: React.FormEvent) => {
    e.preventDefault();
    const numLength = parseFloat(length);
    if (numLength > 0) {
      onStartDrawing(numLength, unit);
    }
  };

  const handleConfirm = () => {
    const numLength = parseFloat(length);
    if (numLength > 0) {
      onConfirm(numLength, unit, applyToAll);
    }
  };

  if (mode === 'input') {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl p-6 w-96">
          <h3 className="text-lg font-semibold mb-2">Set Scale</h3>
          <p className="text-sm text-gray-600 mb-4">
            Enter a known dimension from your drawing, then trace over it.
          </p>
          <form onSubmit={handleStartDrawing}>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                What length will you trace?
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                  placeholder="e.g., 10"
                  className="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-lg"
                  autoFocus
                />
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as 'ft' | 'm')}
                  className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 text-lg"
                >
                  <option value="ft">feet</option>
                  <option value="m">meters</option>
                </select>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Tip: Use a dimension line or scale bar from your drawing
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 px-4 py-2 text-gray-600 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!length || parseFloat(length) <= 0}
                className="flex-1 px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next: Draw Line
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  if (mode === 'drawing') {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50">
        <div className="bg-orange-500 text-white rounded-lg shadow-xl px-6 py-3 flex items-center gap-4">
          <div className="text-lg font-medium">
            Draw a line that represents {length} {unit === 'ft' ? 'feet' : 'meters'}
          </div>
          <button
            onClick={onCancel}
            className="px-3 py-1 bg-white/20 rounded hover:bg-white/30 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'confirm' && pixelLength) {
    const numLength = parseFloat(length);
    const pixelsPerUnit = pixelLength / numLength;
    const ratio = Math.round(pixelsPerUnit);

    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl p-6 w-96">
          <h3 className="text-lg font-semibold mb-2 text-green-600">Scale Set!</h3>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
            <div className="text-center">
              <div className="text-3xl font-bold text-green-700 mb-1">
                1 {unit} = {ratio} px
              </div>
              <div className="text-sm text-green-600">
                ({numLength} {unit} = {Math.round(pixelLength)} pixels)
              </div>
            </div>
          </div>

          {/* Apply to all sheets option */}
          {sheetCount > 1 && (
            <label className="flex items-center gap-2 mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg cursor-pointer hover:bg-blue-100">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
                className="w-4 h-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
              />
              <div>
                <span className="text-sm font-medium text-blue-800">
                  Apply to all {sheetCount} sheets
                </span>
                <p className="text-xs text-blue-600">
                  Use this scale for sheets at the same scale
                </p>
              </div>
            </label>
          )}

          <p className="text-sm text-gray-600 mb-4">
            {applyToAll
              ? `All ${sheetCount} sheets will use this scale.`
              : 'This scale applies to the current sheet only.'}{' '}
            Press K to recalibrate anytime.
          </p>
          <button
            onClick={handleConfirm}
            className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            {applyToAll ? `Apply to All ${sheetCount} Sheets` : 'Start Measuring'}
          </button>
        </div>
      </div>
    );
  }

  return null;
}

export function TakeoffToolbar() {
  const {
    activeTool,
    setActiveTool,
    snapEnabled,
    gridEnabled,
    toggleSnap,
    toggleGrid,
    activeCategory,
    canUndo,
    canRedo,
    undo,
    redo,
    calibration,
    isCalibrating,
    calibrationLine,
    startCalibration,
    completeCalibration,
    cancelCalibration,
    project,
    zoom,
  } = useTakeoffStore();

  const { addToast } = useToast();
  const sheetCount = project?.sheets.length || 1;

  // Wrapped undo with toast feedback
  const handleUndo = useCallback(() => {
    const result = undo();
    if (result) {
      addToast({ type: 'info', message: 'Undo: Measurement restored', duration: 2000 });
    } else if (canUndo) {
      addToast({ type: 'info', message: 'Undo', duration: 1500 });
    }
  }, [undo, canUndo, addToast]);

  // Wrapped redo with toast feedback
  const handleRedo = useCallback(() => {
    const result = redo();
    if (result) {
      addToast({ type: 'info', message: 'Redo: Measurement restored', duration: 2000 });
    } else if (canRedo) {
      addToast({ type: 'info', message: 'Redo', duration: 1500 });
    }
  }, [redo, canRedo, addToast]);

  // Check if a tool is compatible with the active category
  const isToolCompatible = (tool: typeof tools[0]) => {
    // Select tool is always available
    if (tool.id === 'select') return true;
    // If no category selected, all tools available
    if (!activeCategory) return true;
    // Tool must match category's measurement type
    return tool.measurementType === activeCategory.measurementType;
  };

  const [calibrationMode, setCalibrationMode] = useState<'input' | 'drawing' | 'confirm' | null>(null);
  const [pendingCalibration, setPendingCalibration] = useState<{ length: number; unit: 'ft' | 'm' } | null>(null);
  const [pixelLength, setPixelLength] = useState<number | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Calculate pixel length when calibration line is drawn
  useEffect(() => {
    if (calibrationLine && calibrationLine.length >= 2) {
      const [start, end] = calibrationLine;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const length = Math.sqrt(dx * dx + dy * dy);
      setPixelLength(length);
      setCalibrationMode('confirm');
    }
  }, [calibrationLine]);

  // Handle pressing K to start calibration
  const handleStartCalibration = () => {
    setCalibrationMode('input');
  };

  // Helper to check if tool shortcut should work
  const canSwitchToTool = (toolId: MeasurementTool) => {
    if (toolId === 'select') return true;
    if (!activeCategory) return true;
    const tool = tools.find((t) => t.id === toolId);
    return tool?.measurementType === activeCategory.measurementType;
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      // Tool shortcuts - only if compatible with active category
      if (key === 'v') setActiveTool('select');
      if (key === 'c' && canSwitchToTool('count')) setActiveTool('count');
      if (key === 'i' && canSwitchToTool('line')) setActiveTool('line');
      if (key === 'l' && canSwitchToTool('linear')) setActiveTool('linear');
      if (key === 'a' && !e.ctrlKey && !e.metaKey && canSwitchToTool('area')) setActiveTool('area');
      if (key === 'r' && canSwitchToTool('rectangle')) setActiveTool('rectangle');
      if (key === 'k') handleStartCalibration();

      // Toggle shortcuts
      if (key === 's' && !e.ctrlKey && !e.metaKey) toggleSnap();
      if (key === 'g') toggleGrid();

      // Help shortcut
      if (key === '?' || (e.shiftKey && key === '/')) {
        setShowShortcuts(prev => !prev);
      }

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }

      // Cancel
      if (key === 'escape') {
        if (calibrationMode) {
          handleCalibrationCancel();
        } else {
          setActiveTool('select');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool, toggleSnap, toggleGrid, handleUndo, handleRedo, calibrationMode, activeCategory]);

  // User enters length and clicks "Draw Line"
  const handleStartDrawing = (length: number, unit: 'ft' | 'm') => {
    setPendingCalibration({ length, unit });
    setCalibrationMode('drawing');
    startCalibration();
  };

  // User confirms the calibration after drawing
  const handleCalibrationConfirm = (length: number, unit: 'ft' | 'm', applyToAll: boolean) => {
    completeCalibration(length, unit, applyToAll);
    setCalibrationMode(null);
    setPendingCalibration(null);
    setPixelLength(null);
  };

  const handleCalibrationCancel = () => {
    cancelCalibration();
    setCalibrationMode(null);
    setPendingCalibration(null);
    setPixelLength(null);
  };

  return (
    <>
      <div className="flex flex-col gap-1 p-2 bg-white rounded-lg shadow-md">
        {/* Tool buttons */}
        {tools.map((tool) => {
          const compatible = isToolCompatible(tool);
          const isActive = activeTool === tool.id;

          return (
            <button
              key={tool.id}
              onClick={() => compatible && setActiveTool(tool.id)}
              disabled={!compatible}
              className={`w-10 h-10 flex items-center justify-center rounded-lg text-lg transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : compatible
                    ? 'hover:bg-gray-100 text-gray-700'
                    : 'text-gray-300 cursor-not-allowed'
              }`}
              title={
                compatible
                  ? `${tool.label} (${tool.shortcut})`
                  : `${tool.label} - incompatible with ${activeCategory?.name} (${activeCategory?.measurementType})`
              }
            >
              {tool.icon}
            </button>
          );
        })}

        {/* Divider */}
        <div className="h-px bg-gray-200 my-1" />

        {/* Scale Calibration button */}
        <button
          onClick={handleStartCalibration}
          className={`w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors ${
            activeTool === 'calibrate'
              ? 'bg-orange-500 text-white'
              : calibration
                ? 'bg-green-100 text-green-700'
                : 'hover:bg-gray-100 text-gray-700'
          }`}
          title={
            calibration
              ? `Scale: 1 ${calibration.unit} = ${Math.round(calibration.pixelsPerUnit)} px (K to recalibrate)`
              : 'Set Scale (K)'
          }
        >
          📏
        </button>

        {/* Toggle buttons */}
        <button
          onClick={toggleSnap}
          className={`w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors ${
            snapEnabled
              ? 'bg-green-100 text-green-700'
              : 'hover:bg-gray-100 text-gray-400'
          }`}
          title={`Snapping ${snapEnabled ? 'ON' : 'OFF'} (S)`}
        >
          ◉
        </button>

        <button
          onClick={toggleGrid}
          className={`w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors ${
            gridEnabled
              ? 'bg-green-100 text-green-700'
              : 'hover:bg-gray-100 text-gray-400'
          }`}
          title={`Grid ${gridEnabled ? 'ON' : 'OFF'} (G)`}
        >
          ⊞
        </button>

        {/* Divider */}
        <div className="h-px bg-gray-200 my-1" />

        {/* Undo/Redo buttons */}
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className={`w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors ${
            canUndo
              ? 'hover:bg-gray-100 text-gray-700'
              : 'text-gray-300 cursor-not-allowed'
          }`}
          title="Undo (Ctrl+Z)"
        >
          ↶
        </button>

        <button
          onClick={handleRedo}
          disabled={!canRedo}
          className={`w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors ${
            canRedo
              ? 'hover:bg-gray-100 text-gray-700'
              : 'text-gray-300 cursor-not-allowed'
          }`}
          title="Redo (Ctrl+Y)"
        >
          ↷
        </button>

        {/* Divider */}
        <div className="h-px bg-gray-200 my-1" />

        {/* Scale indicator */}
        {calibration && (
          <div
            className="w-10 h-10 flex flex-col items-center justify-center rounded-lg text-[10px] font-mono bg-gray-100 text-gray-600"
            title={`Scale: 1 ${calibration.unit} = ${calibration.pixelsPerUnit.toFixed(1)} px`}
          >
            <span>{Math.round(calibration.pixelsPerUnit)}</span>
            <span className="text-[8px] text-gray-400">px/{calibration.unit}</span>
          </div>
        )}

        {/* Zoom level indicator */}
        <div
          className="w-10 h-10 flex flex-col items-center justify-center rounded-lg text-[10px] font-mono bg-blue-50 text-blue-600"
          title={`Zoom: ${Math.round(zoom * 100)}%`}
        >
          <span>{Math.round(zoom * 100)}%</span>
          <span className="text-[8px] text-blue-400">zoom</span>
        </div>

        {/* Active category indicator */}
        {activeCategory && (
          <div
            className="w-10 h-10 flex items-center justify-center rounded-lg text-xs font-bold"
            style={{ backgroundColor: activeCategory.color + '20', color: activeCategory.color }}
            title={`Active: ${activeCategory.name}`}
          >
            {activeCategory.name.slice(0, 2).toUpperCase()}
          </div>
        )}

        {/* Divider */}
        <div className="h-px bg-gray-200 my-1" />

        {/* Help button */}
        <button
          onClick={() => setShowShortcuts(true)}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-sm transition-colors hover:bg-gray-100 text-gray-500"
          title="Keyboard Shortcuts (?)"
        >
          ?
        </button>
      </div>

      {/* Keyboard shortcuts modal */}
      {showShortcuts && (
        <ShortcutsHelpModal onClose={() => setShowShortcuts(false)} />
      )}

      {/* Calibration dialog */}
      {calibrationMode && (
        <CalibrationDialog
          mode={calibrationMode}
          pixelLength={pixelLength || undefined}
          pendingLength={pendingCalibration?.length}
          pendingUnit={pendingCalibration?.unit}
          onConfirm={handleCalibrationConfirm}
          onCancel={handleCalibrationCancel}
          onStartDrawing={handleStartDrawing}
          sheetCount={sheetCount}
        />
      )}
    </>
  );
}
