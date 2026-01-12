'use client';

import { useTakeoffStore, type TakeoffSheet, type ScaleCalibration } from '@/lib/stores/takeoff-store';
import { useMemo, useState } from 'react';

interface SheetPanelProps {
  onSheetSelect?: (sheet: TakeoffSheet) => void;
  onAddSheets?: () => void;
}

export function TakeoffSheetPanel({ onSheetSelect, onAddSheets }: SheetPanelProps) {
  const { project, currentSheetId, setCurrentSheet, measurements, calibration: currentCalibration, setProject } = useTakeoffStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['all']));
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const sheets = project?.sheets || [];

  // Count measurements per sheet
  const measurementCounts = useMemo(() => {
    const counts = new Map<string, number>();
    measurements.forEach((m) => {
      counts.set(m.sheetId, (counts.get(m.sheetId) || 0) + 1);
    });
    return counts;
  }, [measurements]);

  // Group sheets by prefix (A=Architectural, E=Electrical, etc.)
  const groupedSheets = useMemo(() => {
    const groups = new Map<string, TakeoffSheet[]>();

    sheets
      .filter((s) =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
      .forEach((sheet) => {
        // Extract prefix (e.g., "A" from "A2.1")
        const prefix = sheet.name.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || 'Other';
        const groupName = getGroupName(prefix);

        const existing = groups.get(groupName) || [];
        existing.push(sheet);
        groups.set(groupName, existing);
      });

    return groups;
  }, [sheets, searchQuery]);

  const toggleGroup = (group: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(group)) {
      newExpanded.delete(group);
    } else {
      newExpanded.add(group);
    }
    setExpandedGroups(newExpanded);
  };

  const handleSheetClick = (sheet: TakeoffSheet) => {
    setCurrentSheet(sheet.id);
    onSheetSelect?.(sheet);
  };

  const handleStartRename = (sheet: TakeoffSheet, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSheetId(sheet.id);
    setEditName(sheet.name);
  };

  const handleSaveRename = async (sheetId: string) => {
    if (!editName.trim() || !project) return;

    // Update local state
    setProject({
      ...project,
      sheets: project.sheets.map(s =>
        s.id === sheetId ? { ...s, name: editName.trim() } : s
      ),
    });

    // Save to server
    try {
      await fetch(`/api/takeoff/sheets/${sheetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
    } catch (err) {
      console.error('Failed to rename sheet:', err);
    }

    setEditingSheetId(null);
  };

  const handleCancelRename = () => {
    setEditingSheetId(null);
    setEditName('');
  };

  return (
    <div className="w-64 bg-white border-r flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">Sheets</h2>
        {onAddSheets && (
          <button
            onClick={onAddSheets}
            className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
            title="Add more PDF sheets"
          >
            + Add
          </button>
        )}
      </div>

      {/* Search */}
      <div className="p-3 border-b">
        <input
          type="text"
          placeholder="Search sheets..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border rounded-lg"
        />
      </div>

      {/* Sheet list */}
      <div className="flex-1 overflow-y-auto">
        {sheets.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            <p>No sheets loaded</p>
            <p className="mt-1">Upload a PDF to see sheets</p>
          </div>
        ) : (
          <div>
            {Array.from(groupedSheets.entries()).map(([groupName, groupSheets]) => (
              <div key={groupName}>
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(groupName)}
                  className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-gray-700"
                >
                  <span>
                    📁 {groupName} ({groupSheets.length})
                  </span>
                  <span>{expandedGroups.has(groupName) ? '▼' : '▶'}</span>
                </button>

                {/* Group sheets */}
                {expandedGroups.has(groupName) && (
                  <div className="divide-y">
                    {groupSheets.map((sheet) => {
                      const isActive = currentSheetId === sheet.id;
                      const itemCount = measurementCounts.get(sheet.id) || 0;

                      return (
                        <button
                          key={sheet.id}
                          onClick={() => handleSheetClick(sheet)}
                          className={`w-full flex items-start gap-3 p-3 text-left transition-colors ${
                            isActive ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-gray-50'
                          }`}
                        >
                          {/* Thumbnail placeholder */}
                          <div className="w-12 h-12 bg-gray-200 rounded flex-shrink-0 flex items-center justify-center text-xs text-gray-400">
                            PDF
                          </div>

                          <div className="flex-1 min-w-0">
                            {editingSheetId === sheet.id ? (
                              <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onBlur={() => handleSaveRename(sheet.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveRename(sheet.id);
                                  if (e.key === 'Escape') handleCancelRename();
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="w-full px-1 py-0.5 text-sm font-medium border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                autoFocus
                              />
                            ) : (
                              <p
                                className="font-medium text-gray-900 truncate cursor-text"
                                onDoubleClick={(e) => handleStartRename(sheet, e)}
                                title="Double-click to rename"
                              >
                                {sheet.name}
                              </p>
                            )}
                            <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                              {/* Use calibration from current sheet if active, otherwise from sheet data */}
                              {(() => {
                                const sheetCalibration = isActive ? currentCalibration : sheet.calibration;
                                if (sheetCalibration) {
                                  return (
                                    <span className="text-green-600">
                                      {formatCalibration(sheetCalibration)}
                                    </span>
                                  );
                                }
                                return <span className="text-yellow-600">No scale</span>;
                              })()}
                              <span>•</span>
                              <span>{itemCount} items</span>
                            </div>
                            {!sheet.tilesReady && (
                              <span className="inline-block mt-1 text-xs text-blue-600">
                                Processing...
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t bg-gray-50 text-xs text-gray-500">
        {sheets.length} sheets • {measurements.length} measurements
      </div>
    </div>
  );
}

// Helper to get group name from prefix
function getGroupName(prefix: string): string {
  const prefixMap: Record<string, string> = {
    A: 'Architectural',
    S: 'Structural',
    E: 'Electrical',
    M: 'Mechanical',
    P: 'Plumbing',
    FP: 'Fire Protection',
    C: 'Civil',
    L: 'Landscape',
    I: 'Interiors',
    G: 'General',
  };
  return prefixMap[prefix] || prefix;
}

// Format calibration for display
function formatCalibration(calibration: ScaleCalibration): string {
  const ppu = Math.round(calibration.pixelsPerUnit);
  return `1 ${calibration.unit} = ${ppu} px`;
}
