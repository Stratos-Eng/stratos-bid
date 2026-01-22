'use client';

import { useState } from 'react';
import { TRADE_DEFINITIONS, type TradeCode } from '@/lib/trade-definitions';
import { useToast } from '@/components/ui/toast';

interface LineItem {
  id: string;
  tradeCode: string;
  category: string;
  description: string;
  estimatedQty: string | null;
  unit: string | null;
  notes: string | null;
  pageNumber: number | null;
  pageReference: string | null;
  extractionConfidence: number | null;
  reviewStatus: string;
  documentId: string;
  documentFilename: string | null;
}

interface LineItemsTableProps {
  items: LineItem[];
  bidId: string;
}

const confidenceColors = (confidence: number | null) => {
  if (!confidence) return 'text-gray-400';
  if (confidence >= 0.8) return 'text-green-600';
  if (confidence >= 0.5) return 'text-yellow-600';
  return 'text-red-600';
};

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  modified: 'bg-blue-100 text-blue-800',
};

export function LineItemsTable({ items, bidId }: LineItemsTableProps) {
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isUpdating, setIsUpdating] = useState(false);
  const { addToast } = useToast();

  const toggleItem = (id: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedItems(newSelected);
  };

  const toggleAll = () => {
    if (selectedItems.size === items.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(items.map((i) => i.id)));
    }
  };

  const bulkAction = async (action: 'approve' | 'reject' | 'reset') => {
    if (selectedItems.size === 0) return;

    setIsUpdating(true);
    try {
      const response = await fetch('/api/line-items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedItems),
          action,
        }),
      });

      if (response.ok) {
        addToast({
          type: 'success',
          message: `Successfully ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'reset'} ${selectedItems.size} item${selectedItems.size > 1 ? 's' : ''}`
        });
        // Refresh the page to show updated data
        window.location.reload();
      } else {
        addToast({
          type: 'error',
          message: 'Failed to perform bulk action'
        });
      }
    } catch (error) {
      addToast({
        type: 'error',
        message: 'Failed to perform bulk action'
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const updateItem = async (
    id: string,
    updates: Partial<{ reviewStatus: string; estimatedQty: string; notes: string }>
  ) => {
    try {
      const response = await fetch('/api/line-items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });

      if (response.ok) {
        addToast({
          type: 'success',
          message: updates.reviewStatus
            ? `Item ${updates.reviewStatus}`
            : 'Item updated'
        });
        window.location.reload();
      } else {
        const data = await response.json().catch(() => ({}));
        addToast({
          type: 'error',
          message: data.error || 'Failed to update item'
        });
      }
    } catch (error) {
      addToast({
        type: 'error',
        message: 'Failed to update item'
      });
    }
  };

  return (
    <div>
      {/* Bulk Actions Bar */}
      {selectedItems.size > 0 && (
        <div className="sticky top-0 z-10 bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-blue-800">
            {selectedItems.size} item(s) selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => bulkAction('approve')}
              disabled={isUpdating}
              className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => bulkAction('reject')}
              disabled={isUpdating}
              className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              onClick={() => bulkAction('reset')}
              disabled={isUpdating}
              className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700 disabled:opacity-50"
            >
              Reset
            </button>
            <button
              onClick={() => setSelectedItems(new Set())}
              className="px-3 py-1 text-gray-600 text-sm hover:underline"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  checked={selectedItems.size === items.length && items.length > 0}
                  onChange={toggleAll}
                  className="rounded"
                />
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Category
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Page
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase min-w-[300px]">
                Description
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Est Qty
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Unit
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Conf
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((item) => {
              const trade = TRADE_DEFINITIONS[item.tradeCode as TradeCode];
              return (
                <tr
                  key={item.id}
                  className={`hover:bg-gray-50 ${
                    selectedItems.has(item.id) ? 'bg-blue-50' : ''
                  }`}
                >
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedItems.has(item.id)}
                      onChange={() => toggleItem(item.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-sm font-medium text-gray-900">
                      {item.category}
                    </div>
                    <div className="text-xs text-gray-500">{trade?.name}</div>
                  </td>
                  <td className="px-3 py-3">
                    {item.pageNumber ? (
                      <div className="flex items-center gap-2">
                        <a
                          href={`/bids/${bidId}/documents/${item.documentId}?page=${item.pageNumber}`}
                          className="text-blue-600 hover:underline text-sm"
                          title={`View ${item.documentFilename || 'Document'} - Page ${item.pageNumber}`}
                        >
                          p.{item.pageNumber}
                          {item.pageReference && (
                            <span className="text-gray-400 ml-1">
                              ({item.pageReference})
                            </span>
                          )}
                        </a>
                        <a
                          href={`/api/documents/${item.documentId}/view#page=${item.pageNumber}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-400 hover:text-gray-600 text-xs"
                          title="Open PDF"
                        >
                          PDF
                        </a>
                      </div>
                    ) : (
                      <span className="text-gray-400 text-sm">-</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-sm text-gray-900">{item.description}</p>
                    {item.notes && (
                      <p className="text-xs text-gray-500 mt-1">{item.notes}</p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-sm text-gray-900">
                      {item.estimatedQty || '-'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-sm text-gray-500">
                      {item.unit || '-'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`text-sm font-medium ${confidenceColors(item.extractionConfidence)}`}
                    >
                      {item.extractionConfidence
                        ? `${Math.round(item.extractionConfidence * 100)}%`
                        : '-'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`px-2 py-1 text-xs rounded-full ${statusColors[item.reviewStatus]}`}
                    >
                      {item.reviewStatus}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1">
                      {item.reviewStatus !== 'approved' && (
                        <button
                          onClick={() =>
                            updateItem(item.id, { reviewStatus: 'approved' })
                          }
                          className="p-1 text-green-600 hover:bg-green-50 rounded"
                          title="Approve"
                        >
                          ✓
                        </button>
                      )}
                      {item.reviewStatus !== 'rejected' && (
                        <button
                          onClick={() =>
                            updateItem(item.id, { reviewStatus: 'rejected' })
                          }
                          className="p-1 text-red-600 hover:bg-red-50 rounded"
                          title="Reject"
                        >
                          ✗
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
