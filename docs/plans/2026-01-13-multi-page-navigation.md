# Multi-Page Navigation UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable fast keyboard-first navigation between PDF sheets in the takeoff module with visual position indicators.

**Architecture:** Add next/prev sheet actions to takeoff-store, create a dedicated keyboard hook for takeoff, add sheet position indicator to toolbar, and wire up PageUp/PageDown/[/] shortcuts.

**Tech Stack:** React hooks, Zustand store, TypeScript

---

## Current State

| Component | File | Status |
|-----------|------|--------|
| Sheet list panel | `src/components/takeoff/sheet-panel.tsx` | Exists, click-to-select |
| Takeoff store | `src/lib/stores/takeoff-store.ts` | Has `currentSheetId`, `setCurrentSheet` |
| PDF viewer | `src/components/takeoff/pdf-viewer.tsx` | Displays current sheet |
| Keyboard hook | `src/hooks/use-keyboard-shortcuts.ts` | Exists but for verification module only |

## Implementation Tasks

---

### Task 1: Add Next/Previous Sheet Actions to Store

**Files:**
- Modify: `src/lib/stores/takeoff-store.ts`

**Step 1: Add action types to interface**

Find the `TakeoffState` interface (around line 70) and add after `setCurrentSheet`:

```typescript
  // Sheet navigation
  nextSheet: () => void;
  prevSheet: () => void;
  getSheetIndex: () => { current: number; total: number } | null;
```

**Step 2: Implement the actions**

Find the store implementation (around line 140) and add after `setCurrentSheet`:

```typescript
  nextSheet: () => {
    const { project, currentSheetId } = get();
    if (!project || !currentSheetId) return;

    const sheets = project.sheets;
    const currentIndex = sheets.findIndex(s => s.id === currentSheetId);
    if (currentIndex < sheets.length - 1) {
      set({ currentSheetId: sheets[currentIndex + 1].id });
    }
  },

  prevSheet: () => {
    const { project, currentSheetId } = get();
    if (!project || !currentSheetId) return;

    const sheets = project.sheets;
    const currentIndex = sheets.findIndex(s => s.id === currentSheetId);
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
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/lib/stores/takeoff-store.ts
git commit -m "feat(takeoff): add next/prev sheet navigation actions to store"
```

---

### Task 2: Create Takeoff Keyboard Shortcuts Hook

**Files:**
- Create: `src/hooks/use-takeoff-keyboard.ts`

**Step 1: Create the keyboard hook**

```typescript
// src/hooks/use-takeoff-keyboard.ts
import { useEffect, useCallback } from 'react';
import { useTakeoffStore } from '@/lib/stores/takeoff-store';

interface UseTakeoffKeyboardOptions {
  enabled?: boolean;
}

export function useTakeoffKeyboard({ enabled = true }: UseTakeoffKeyboardOptions = {}) {
  const {
    activeTool,
    setActiveTool,
    nextSheet,
    prevSheet,
    toggleSnap,
    isDrawing,
    isCalibrating,
    setIsCalibrating,
  } = useTakeoffStore();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if typing in input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Ignore if disabled or currently drawing
      if (!enabled || isDrawing) return;

      const key = e.key.toLowerCase();
      const hasModifier = e.metaKey || e.ctrlKey;

      // === SHEET NAVIGATION ===

      // PageDown or ] = next sheet
      if (e.key === 'PageDown' || key === ']') {
        e.preventDefault();
        nextSheet();
        return;
      }

      // PageUp or [ = previous sheet
      if (e.key === 'PageUp' || key === '[') {
        e.preventDefault();
        prevSheet();
        return;
      }

      // === TOOL SELECTION ===

      // V = select tool
      if (key === 'v' && !hasModifier) {
        e.preventDefault();
        setActiveTool('select');
        return;
      }

      // C = count tool
      if (key === 'c' && !hasModifier) {
        e.preventDefault();
        setActiveTool('count');
        return;
      }

      // L = line tool
      if (key === 'l' && !hasModifier) {
        e.preventDefault();
        setActiveTool('line');
        return;
      }

      // P = polyline (linear) tool
      if (key === 'p' && !hasModifier) {
        e.preventDefault();
        setActiveTool('linear');
        return;
      }

      // A = area tool
      if (key === 'a' && !hasModifier) {
        e.preventDefault();
        setActiveTool('area');
        return;
      }

      // R = rectangle tool
      if (key === 'r' && !hasModifier) {
        e.preventDefault();
        setActiveTool('rectangle');
        return;
      }

      // K = calibrate (scale)
      if (key === 'k' && !hasModifier) {
        e.preventDefault();
        setActiveTool('calibrate');
        setIsCalibrating(true);
        return;
      }

      // === TOGGLES ===

      // S = toggle snap
      if (key === 's' && !hasModifier) {
        e.preventDefault();
        toggleSnap();
        return;
      }

      // Escape = cancel current operation
      if (key === 'escape') {
        e.preventDefault();
        if (isCalibrating) {
          setIsCalibrating(false);
          setActiveTool('select');
        }
        return;
      }
    },
    [
      enabled,
      isDrawing,
      isCalibrating,
      nextSheet,
      prevSheet,
      setActiveTool,
      toggleSnap,
      setIsCalibrating,
    ]
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
}
```

**Step 2: Export from hooks index (if exists) or verify import path**

Run: `ls -la src/hooks/`
If `index.ts` exists, add export. Otherwise, direct import will work.

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/hooks/use-takeoff-keyboard.ts
git commit -m "feat(takeoff): create keyboard shortcuts hook for takeoff module"
```

---

### Task 3: Add Sheet Position Indicator Component

**Files:**
- Create: `src/components/takeoff/sheet-navigator.tsx`

**Step 1: Create the sheet navigator component**

```typescript
// src/components/takeoff/sheet-navigator.tsx
'use client';

import { useTakeoffStore } from '@/lib/stores/takeoff-store';

export function SheetNavigator() {
  const { project, currentSheetId, nextSheet, prevSheet, getSheetIndex } = useTakeoffStore();

  const index = getSheetIndex();
  const currentSheet = project?.sheets.find(s => s.id === currentSheetId);

  if (!index || !currentSheet) return null;

  const canGoPrev = index.current > 1;
  const canGoNext = index.current < index.total;

  return (
    <div className="flex items-center gap-2 bg-white rounded-lg shadow border px-3 py-2">
      {/* Previous button */}
      <button
        onClick={prevSheet}
        disabled={!canGoPrev}
        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed"
        title="Previous sheet ([)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Sheet info */}
      <div className="flex flex-col items-center min-w-[80px]">
        <span className="text-xs text-gray-500">
          {index.current} / {index.total}
        </span>
        <span className="text-xs font-medium text-gray-700 truncate max-w-[120px]" title={currentSheet.name}>
          {currentSheet.name}
        </span>
      </div>

      {/* Next button */}
      <button
        onClick={nextSheet}
        disabled={!canGoNext}
        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed"
        title="Next sheet (])"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/components/takeoff/sheet-navigator.tsx
git commit -m "feat(takeoff): add sheet navigator component with position indicator"
```

---

### Task 4: Wire Up Keyboard Hook and Navigator in Main Page

**Files:**
- Modify: `src/app/(dashboard)/takeoff/[projectId]/page.tsx`

**Step 1: Import the keyboard hook**

Add import at top of file:

```typescript
import { useTakeoffKeyboard } from '@/hooks/use-takeoff-keyboard';
import { SheetNavigator } from '@/components/takeoff/sheet-navigator';
```

**Step 2: Initialize keyboard hook**

Inside `TakeoffWorkspacePage` component, add after the existing hooks:

```typescript
  // Enable keyboard shortcuts
  useTakeoffKeyboard({ enabled: !loading && !error });
```

**Step 3: Add SheetNavigator to the UI**

Find the top bar section (around line 433) and add the navigator after the measurements count:

```typescript
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {/* Sheet Navigator */}
          <SheetNavigator />
          <span className="text-gray-300">|</span>
          {currentSheet && <span>Sheet: {currentSheet.name}</span>}
```

Actually, better placement - add it in the PDF viewer area, floating at bottom-center. Find the PDF viewer section (around line 525) and add after the `<PdfViewer>` component:

```typescript
          {/* Sheet navigator - floating at bottom center */}
          {currentSheet && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
              <SheetNavigator />
            </div>
          )}
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/app/\(dashboard\)/takeoff/\[projectId\]/page.tsx
git commit -m "feat(takeoff): wire up keyboard shortcuts and sheet navigator"
```

---

### Task 5: Add Keyboard Shortcut Hints to Sheet Panel

**Files:**
- Modify: `src/components/takeoff/sheet-panel.tsx`

**Step 1: Add keyboard hint to footer**

Find the footer section (around line 287) and update:

```typescript
      {/* Footer */}
      <div className="p-3 border-t bg-gray-50 text-xs text-gray-500 space-y-1">
        <div>{sheets.length} sheets • {measurements.length} measurements</div>

        {/* Keyboard hint */}
        <div className="text-gray-400">
          <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px]">[</kbd>
          <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px] ml-1">]</kbd>
          <span className="ml-1">to navigate</span>
        </div>

        {/* Batch extraction progress */}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/components/takeoff/sheet-panel.tsx
git commit -m "feat(takeoff): add keyboard navigation hints to sheet panel"
```

---

### Task 6: Add Visual Feedback for Sheet Changes

**Files:**
- Modify: `src/components/takeoff/sheet-navigator.tsx`

**Step 1: Add transition animation**

Update the component to include a flash effect when sheet changes:

```typescript
// src/components/takeoff/sheet-navigator.tsx
'use client';

import { useEffect, useState } from 'react';
import { useTakeoffStore } from '@/lib/stores/takeoff-store';

export function SheetNavigator() {
  const { project, currentSheetId, nextSheet, prevSheet, getSheetIndex } = useTakeoffStore();
  const [flash, setFlash] = useState(false);

  const index = getSheetIndex();
  const currentSheet = project?.sheets.find(s => s.id === currentSheetId);

  // Flash effect when sheet changes
  useEffect(() => {
    if (currentSheetId) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 200);
      return () => clearTimeout(timer);
    }
  }, [currentSheetId]);

  if (!index || !currentSheet) return null;

  const canGoPrev = index.current > 1;
  const canGoNext = index.current < index.total;

  return (
    <div className={`flex items-center gap-2 bg-white rounded-lg shadow border px-3 py-2 transition-all duration-200 ${flash ? 'ring-2 ring-blue-400 scale-105' : ''}`}>
      {/* Previous button */}
      <button
        onClick={prevSheet}
        disabled={!canGoPrev}
        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous sheet ([ or PageUp)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Sheet info */}
      <div className="flex flex-col items-center min-w-[80px]">
        <span className="text-xs text-gray-500 tabular-nums">
          {index.current} / {index.total}
        </span>
        <span className="text-xs font-medium text-gray-700 truncate max-w-[120px]" title={currentSheet.name}>
          {currentSheet.name}
        </span>
      </div>

      {/* Next button */}
      <button
        onClick={nextSheet}
        disabled={!canGoNext}
        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next sheet (] or PageDown)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/components/takeoff/sheet-navigator.tsx
git commit -m "feat(takeoff): add visual flash feedback on sheet navigation"
```

---

### Task 7: Integration Test

**Step 1: Start dev server**

```bash
npm run dev
```

**Step 2: Manual testing checklist**

1. Open a takeoff project with multiple sheets
2. Verify sheet navigator appears at bottom center of PDF viewer
3. Test keyboard navigation:
   - Press `]` → should go to next sheet
   - Press `[` → should go to previous sheet
   - Press `PageDown` → should go to next sheet
   - Press `PageUp` → should go to previous sheet
4. Verify visual feedback:
   - Navigator should flash blue on sheet change
   - Position counter should update
   - Sheet name should update
5. Test edge cases:
   - First sheet: `[` should be disabled/no-op
   - Last sheet: `]` should be disabled/no-op
6. Test tool shortcuts still work:
   - `V` → select tool
   - `C` → count tool
   - `L` → line tool
   - `S` → toggle snap

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(takeoff): complete multi-page navigation UX

- Keyboard shortcuts: [ ] PageUp PageDown for sheet navigation
- Sheet navigator component with position indicator
- Visual flash feedback on navigation
- Tool shortcuts: V C L P A R K S
- Keyboard hints in sheet panel footer"
```

---

## Summary

| Task | Component | Description |
|------|-----------|-------------|
| 1 | Store | Add nextSheet/prevSheet actions |
| 2 | Hook | Create useTakeoffKeyboard |
| 3 | Component | SheetNavigator with position indicator |
| 4 | Integration | Wire up in main page |
| 5 | UX | Keyboard hints in panel footer |
| 6 | Polish | Visual flash feedback |
| 7 | Testing | Manual integration test |

## Keyboard Shortcuts Reference

| Key | Action |
|-----|--------|
| `]` or `PageDown` | Next sheet |
| `[` or `PageUp` | Previous sheet |
| `V` | Select tool |
| `C` | Count tool |
| `L` | Line tool |
| `P` | Polyline tool |
| `A` | Area tool |
| `R` | Rectangle tool |
| `K` | Calibrate scale |
| `S` | Toggle snap |
| `Escape` | Cancel current operation |
