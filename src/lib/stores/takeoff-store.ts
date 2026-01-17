import { create } from 'zustand';

export type MeasurementTool = 'select' | 'count' | 'line' | 'linear' | 'area' | 'rectangle' | 'calibrate';
export type MeasurementType = 'count' | 'linear' | 'area';

// Scale calibration state
export interface ScaleCalibration {
  pixelLength: number; // Length in pixels of calibration line
  realLength: number; // Real-world length entered by user
  unit: 'ft' | 'm'; // Unit of real-world length
  pixelsPerUnit: number; // Computed: pixelLength / realLength
}

export interface TakeoffMeasurement {
  id: string;
  sheetId: string;
  categoryId: string;
  type: MeasurementType;
  geometry: {
    type: 'Point' | 'LineString' | 'Polygon';
    coordinates: number[] | number[][] | number[][][];
  };
  quantity: number;
  unit: string;
  label?: string;
  createdAt: Date;
}

export interface TakeoffCategory {
  id: string;
  projectId: string;
  name: string;
  color: string;
  measurementType: MeasurementType;
  sortOrder: number;
}

export interface TakeoffSheet {
  id: string;
  projectId: string;
  documentId: string;
  pageNumber: number;
  name: string;
  widthPx: number;
  heightPx: number;
  // New calibration field (preferred)
  calibration?: ScaleCalibration | null;
  // Legacy scale fields (deprecated)
  scale: number | null;
  scaleUnit: string;
  tilesReady: boolean;
  tileUrlTemplate: string | null;
}

export interface TakeoffProject {
  id: string;
  name: string;
  bidId: string | null;
  defaultUnit: 'imperial' | 'metric';
  sheets: TakeoffSheet[];
  categories: TakeoffCategory[];
}

// Undo/Redo action types
type UndoAction =
  | { type: 'add'; measurement: TakeoffMeasurement }
  | { type: 'delete'; measurement: TakeoffMeasurement }
  | { type: 'update'; id: string; before: Partial<TakeoffMeasurement>; after: Partial<TakeoffMeasurement> };

interface TakeoffState {
  // Current project context
  project: TakeoffProject | null;
  currentSheetId: string | null;

  // Tool state
  activeTool: MeasurementTool;
  activeCategory: TakeoffCategory | null;

  // UI state
  isDrawing: boolean;
  snapEnabled: boolean;
  gridEnabled: boolean;

  // Measurements for current sheet
  measurements: TakeoffMeasurement[];
  selectedMeasurementIds: string[];

  // Zoom/pan state
  zoom: number;
  center: [number, number];

  // Scale calibration
  calibration: ScaleCalibration | null;
  isCalibrating: boolean;
  calibrationLine: [number, number][] | null; // Temporary line during calibration

  // Undo/redo stacks
  undoStack: UndoAction[];
  redoStack: UndoAction[];
  canUndo: boolean;
  canRedo: boolean;

  // Actions
  setProject: (project: TakeoffProject | null) => void;
  setCurrentSheet: (sheetId: string | null) => void;

  // Sheet navigation
  nextSheet: () => void;
  prevSheet: () => void;
  getSheetIndex: () => { current: number; total: number } | null;
  setActiveTool: (tool: MeasurementTool) => void;
  setActiveCategory: (category: TakeoffCategory | null) => void;
  setIsDrawing: (drawing: boolean) => void;
  toggleSnap: () => void;
  toggleGrid: () => void;
  setZoom: (zoom: number) => void;
  setCenter: (center: [number, number]) => void;

  // Measurement actions
  addMeasurement: (measurement: TakeoffMeasurement) => void;
  updateMeasurement: (id: string, updates: Partial<TakeoffMeasurement>) => void;
  deleteMeasurement: (id: string) => void;
  selectMeasurement: (id: string, addToSelection?: boolean) => void;
  clearSelection: () => void;
  setMeasurements: (measurements: TakeoffMeasurement[]) => void;

  // Pan/zoom to measurement
  panToMeasurement: ((id: string) => void) | null;
  setPanToMeasurement: (fn: ((id: string) => void) | null) => void;

  // Undo/Redo actions
  undo: () => TakeoffMeasurement | null;
  redo: () => TakeoffMeasurement | null;
  clearHistory: () => void;

  // Scale calibration actions
  startCalibration: () => void;
  setCalibrationLine: (line: [number, number][] | null) => void;
  completeCalibration: (realLength: number, unit: 'ft' | 'm', applyToAll?: boolean) => void;
  cancelCalibration: () => void;
  setCalibration: (calibration: ScaleCalibration | null) => void;
  saveCalibrationToServer: (applyToAll?: boolean) => Promise<void>;
}

const MAX_UNDO_STACK = 50;

export const useTakeoffStore = create<TakeoffState>((set, get) => ({
  // Initial state
  project: null,
  currentSheetId: null,
  activeTool: 'select',
  activeCategory: null,
  isDrawing: false,
  snapEnabled: true,
  gridEnabled: false,
  measurements: [],
  selectedMeasurementIds: [],
  zoom: 1,
  center: [0, 0],
  panToMeasurement: null,
  calibration: null,
  isCalibrating: false,
  calibrationLine: null,
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  // Actions
  setProject: (project) => set({ project }),

  setCurrentSheet: (sheetId) => set({ currentSheetId: sheetId }),

  nextSheet: () => {
    const { project, currentSheetId } = get();
    if (!project || !currentSheetId) return;

    const sheets = project.sheets;
    const currentIndex = sheets.findIndex(s => s.id === currentSheetId);
    if (currentIndex === -1) return;
    if (currentIndex < sheets.length - 1) {
      set({ currentSheetId: sheets[currentIndex + 1].id });
    }
  },

  prevSheet: () => {
    const { project, currentSheetId } = get();
    if (!project || !currentSheetId) return;

    const sheets = project.sheets;
    const currentIndex = sheets.findIndex(s => s.id === currentSheetId);
    if (currentIndex === -1) return;
    if (currentIndex > 0) {
      set({ currentSheetId: sheets[currentIndex - 1].id });
    }
  },

  getSheetIndex: () => {
    const { project, currentSheetId } = get();
    if (!project || !currentSheetId) return null;

    const sheets = project.sheets;
    const currentIndex = sheets.findIndex(s => s.id === currentSheetId);
    if (currentIndex === -1) return null;

    return { current: currentIndex + 1, total: sheets.length };
  },

  setActiveTool: (tool) => set({ activeTool: tool, isDrawing: false }),

  setActiveCategory: (category) => {
    if (!category) {
      set({ activeCategory: null });
      return;
    }

    // Auto-select the appropriate tool based on category type
    const toolMap: Record<MeasurementType, MeasurementTool> = {
      count: 'count',
      linear: 'linear',
      area: 'area',
    };
    const tool = toolMap[category.measurementType] || 'count';

    set({
      activeCategory: category,
      activeTool: tool,
    });
  },

  setIsDrawing: (drawing) => set({ isDrawing: drawing }),

  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

  toggleGrid: () => set((state) => ({ gridEnabled: !state.gridEnabled })),

  setZoom: (zoom) => set({ zoom }),

  setCenter: (center) => set({ center }),

  addMeasurement: (measurement) =>
    set((state) => {
      const newUndoStack = [...state.undoStack, { type: 'add' as const, measurement }].slice(-MAX_UNDO_STACK);
      return {
        measurements: [...state.measurements, measurement],
        undoStack: newUndoStack,
        redoStack: [], // Clear redo stack on new action
        canUndo: true,
        canRedo: false,
      };
    }),

  updateMeasurement: (id, updates) =>
    set((state) => {
      const existing = state.measurements.find((m) => m.id === id);
      if (!existing) return state;

      const before: Partial<TakeoffMeasurement> = {};
      const after: Partial<TakeoffMeasurement> = {};
      for (const key of Object.keys(updates) as (keyof TakeoffMeasurement)[]) {
        before[key] = existing[key] as never;
        after[key] = updates[key] as never;
      }

      const newUndoStack = [...state.undoStack, { type: 'update' as const, id, before, after }].slice(-MAX_UNDO_STACK);

      return {
        measurements: state.measurements.map((m) =>
          m.id === id ? { ...m, ...updates } : m
        ),
        undoStack: newUndoStack,
        redoStack: [],
        canUndo: true,
        canRedo: false,
      };
    }),

  deleteMeasurement: (id) =>
    set((state) => {
      const measurement = state.measurements.find((m) => m.id === id);
      if (!measurement) return state;

      const newUndoStack = [...state.undoStack, { type: 'delete' as const, measurement }].slice(-MAX_UNDO_STACK);

      return {
        measurements: state.measurements.filter((m) => m.id !== id),
        selectedMeasurementIds: state.selectedMeasurementIds.filter((sid) => sid !== id),
        undoStack: newUndoStack,
        redoStack: [],
        canUndo: true,
        canRedo: false,
      };
    }),

  selectMeasurement: (id, addToSelection = false) =>
    set((state) => ({
      selectedMeasurementIds: addToSelection
        ? [...state.selectedMeasurementIds, id]
        : [id],
    })),

  clearSelection: () => set({ selectedMeasurementIds: [] }),

  setMeasurements: (measurements) => set({ measurements, undoStack: [], redoStack: [], canUndo: false, canRedo: false }),

  setPanToMeasurement: (fn) => set({ panToMeasurement: fn }),

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) return null;

    const action = state.undoStack[state.undoStack.length - 1];
    const newUndoStack = state.undoStack.slice(0, -1);
    let newMeasurements = [...state.measurements];
    let restoredMeasurement: TakeoffMeasurement | null = null;

    switch (action.type) {
      case 'add':
        // Undo add = remove the measurement
        newMeasurements = newMeasurements.filter((m) => m.id !== action.measurement.id);
        break;
      case 'delete':
        // Undo delete = restore the measurement
        newMeasurements.push(action.measurement);
        restoredMeasurement = action.measurement;
        break;
      case 'update':
        // Undo update = restore previous values
        newMeasurements = newMeasurements.map((m) =>
          m.id === action.id ? { ...m, ...action.before } : m
        );
        break;
    }

    set({
      measurements: newMeasurements,
      undoStack: newUndoStack,
      redoStack: [...state.redoStack, action],
      canUndo: newUndoStack.length > 0,
      canRedo: true,
    });

    return restoredMeasurement;
  },

  redo: () => {
    const state = get();
    if (state.redoStack.length === 0) return null;

    const action = state.redoStack[state.redoStack.length - 1];
    const newRedoStack = state.redoStack.slice(0, -1);
    let newMeasurements = [...state.measurements];
    let restoredMeasurement: TakeoffMeasurement | null = null;

    switch (action.type) {
      case 'add':
        // Redo add = add the measurement back
        newMeasurements.push(action.measurement);
        restoredMeasurement = action.measurement;
        break;
      case 'delete':
        // Redo delete = remove the measurement again
        newMeasurements = newMeasurements.filter((m) => m.id !== action.measurement.id);
        break;
      case 'update':
        // Redo update = apply the after values
        newMeasurements = newMeasurements.map((m) =>
          m.id === action.id ? { ...m, ...action.after } : m
        );
        break;
    }

    set({
      measurements: newMeasurements,
      undoStack: [...state.undoStack, action],
      redoStack: newRedoStack,
      canUndo: true,
      canRedo: newRedoStack.length > 0,
    });

    return restoredMeasurement;
  },

  clearHistory: () => set({ undoStack: [], redoStack: [], canUndo: false, canRedo: false }),

  // Scale calibration
  startCalibration: () =>
    set({
      activeTool: 'calibrate',
      isCalibrating: true,
      calibrationLine: null,
    }),

  setCalibrationLine: (line) => set({ calibrationLine: line }),

  completeCalibration: (realLength, unit, applyToAll = false) => {
    const state = get();
    if (!state.calibrationLine || state.calibrationLine.length < 2) return;

    // Calculate pixel distance from calibration line
    const [start, end] = state.calibrationLine;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const pixelLength = Math.sqrt(dx * dx + dy * dy);

    if (pixelLength === 0 || realLength <= 0) return;

    const pixelsPerUnit = pixelLength / realLength;

    const calibration = {
      pixelLength,
      realLength,
      unit,
      pixelsPerUnit,
    };

    set({
      calibration,
      isCalibrating: false,
      calibrationLine: null,
      activeTool: 'select',
    });

    // Save to server (async, don't block UI)
    get().saveCalibrationToServer(applyToAll);
  },

  cancelCalibration: () =>
    set({
      isCalibrating: false,
      calibrationLine: null,
      activeTool: 'select',
    }),

  setCalibration: (calibration) => set({ calibration }),

  saveCalibrationToServer: async (applyToAll = false) => {
    const state = get();
    if (!state.currentSheetId || !state.calibration) return;

    try {
      // If applying to all sheets, send to all of them
      const sheetIds = applyToAll && state.project
        ? state.project.sheets.map(s => s.id)
        : [state.currentSheetId];

      await Promise.all(sheetIds.map(async (sheetId) => {
        const response = await fetch(`/api/takeoff/sheets/${sheetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calibration: state.calibration }),
        });

        if (!response.ok) {
          console.error(`Failed to save calibration for sheet ${sheetId}:`, await response.text());
        }
      }));

      // Update local project state with calibration for all sheets
      if (applyToAll && state.project) {
        set({
          project: {
            ...state.project,
            sheets: state.project.sheets.map(s => ({
              ...s,
              calibration: state.calibration,
            })),
          },
        });
      }
    } catch (error) {
      console.error('Failed to save calibration:', error);
    }
  },
}));

// Keyboard shortcuts helper
export const TAKEOFF_SHORTCUTS: Record<string, { key: string; description: string; tool?: MeasurementTool }> = {
  select: { key: 'v', description: 'Select tool', tool: 'select' },
  count: { key: 'c', description: 'Count tool', tool: 'count' },
  linear: { key: 'l', description: 'Linear measurement', tool: 'linear' },
  area: { key: 'a', description: 'Area measurement', tool: 'area' },
  rectangle: { key: 'r', description: 'Rectangle area', tool: 'rectangle' },
  escape: { key: 'Escape', description: 'Cancel/Deselect' },
  delete: { key: 'Delete', description: 'Delete selected' },
  undo: { key: 'z', description: 'Undo (Ctrl+Z)' },
  redo: { key: 'y', description: 'Redo (Ctrl+Y)' },
  toggleSnap: { key: 's', description: 'Toggle snapping' },
  toggleGrid: { key: 'g', description: 'Toggle grid' },
  zoomIn: { key: '+', description: 'Zoom in' },
  zoomOut: { key: '-', description: 'Zoom out' },
  fitView: { key: 'Home', description: 'Fit to view' },
};
