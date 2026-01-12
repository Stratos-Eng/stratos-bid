import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { bids, lineItems, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { TRADE_DEFINITIONS, type TradeCode } from '@/lib/trade-definitions';

// GET /api/export?bidId=xxx - Export line items to Excel
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const bidId = searchParams.get('bidId');
    const tradeCode = searchParams.get('trade');
    const statusFilter = searchParams.get('status');

    if (!bidId) {
      return NextResponse.json({ error: 'bidId is required' }, { status: 400 });
    }

    // Verify bid ownership
    const [bid] = await db
      .select()
      .from(bids)
      .where(and(eq(bids.id, bidId), eq(bids.userId, session.user.id)))
      .limit(1);

    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }

    // Build conditions for line items
    const conditions = [
      eq(lineItems.bidId, bidId),
      eq(lineItems.userId, session.user.id),
    ];

    if (tradeCode) {
      conditions.push(eq(lineItems.tradeCode, tradeCode));
    }
    if (statusFilter) {
      conditions.push(eq(lineItems.reviewStatus, statusFilter));
    }

    // Fetch line items
    const items = await db
      .select()
      .from(lineItems)
      .where(and(...conditions))
      .orderBy(lineItems.tradeCode, lineItems.category, lineItems.pageNumber);

    // Fetch documents for filenames
    const bidDocuments = await db
      .select({
        id: documents.id,
        filename: documents.filename,
      })
      .from(documents)
      .where(eq(documents.bidId, bidId));

    const docMap = new Map(bidDocuments.map((d) => [d.id, d.filename]));

    // Create workbook
    const workbook = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ['Project Information'],
      ['Project Title', bid.title],
      ['Location', bid.city && bid.state ? `${bid.city}, ${bid.state}` : 'N/A'],
      ['Due Date', bid.bidDueDate ? bid.bidDueDate.toLocaleDateString() : 'N/A'],
      ['Source', bid.sourcePlatform],
      [''],
      ['Export Information'],
      ['Total Items', items.length.toString()],
      ['Export Date', new Date().toLocaleDateString()],
      ['Exported By', session.user.email || 'Unknown'],
    ];

    // Add trade breakdown
    const tradeCounts: Record<string, number> = {};
    items.forEach((item) => {
      tradeCounts[item.tradeCode] = (tradeCounts[item.tradeCode] || 0) + 1;
    });

    summaryData.push(['']);
    summaryData.push(['Items by Trade']);
    Object.entries(tradeCounts).forEach(([code, count]) => {
      const trade = TRADE_DEFINITIONS[code as TradeCode];
      summaryData.push([trade?.name || code, count.toString()]);
    });

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    // Line Items sheet
    const lineItemsData = [
      [
        'Trade',
        'Category',
        'Description',
        'Est Qty',
        'Unit',
        'Notes',
        'Page',
        'Page Ref',
        'Document',
        'Confidence',
        'Status',
      ],
    ];

    items.forEach((item) => {
      const trade = TRADE_DEFINITIONS[item.tradeCode as TradeCode];
      lineItemsData.push([
        trade?.name || item.tradeCode,
        item.category,
        item.description,
        item.estimatedQty || '',
        item.unit || '',
        item.notes || '',
        item.pageNumber?.toString() || '',
        item.pageReference || '',
        docMap.get(item.documentId) || '',
        item.extractionConfidence
          ? `${Math.round(item.extractionConfidence * 100)}%`
          : '',
        item.reviewStatus,
      ]);
    });

    const lineItemsSheet = XLSX.utils.aoa_to_sheet(lineItemsData);

    // Set column widths
    lineItemsSheet['!cols'] = [
      { wch: 12 }, // Trade
      { wch: 20 }, // Category
      { wch: 50 }, // Description
      { wch: 10 }, // Est Qty
      { wch: 8 }, // Unit
      { wch: 30 }, // Notes
      { wch: 6 }, // Page
      { wch: 10 }, // Page Ref
      { wch: 30 }, // Document
      { wch: 10 }, // Confidence
      { wch: 10 }, // Status
    ];

    XLSX.utils.book_append_sheet(workbook, lineItemsSheet, 'Line Items');

    // Create separate sheets per trade if multiple trades
    const trades = [...new Set(items.map((i) => i.tradeCode))];
    if (trades.length > 1) {
      trades.forEach((code) => {
        const tradeItems = items.filter((i) => i.tradeCode === code);
        const trade = TRADE_DEFINITIONS[code as TradeCode];

        const tradeData = [
          ['Category', 'Description', 'Est Qty', 'Unit', 'Notes', 'Page', 'Status'],
        ];

        tradeItems.forEach((item) => {
          tradeData.push([
            item.category,
            item.description,
            item.estimatedQty || '',
            item.unit || '',
            item.notes || '',
            item.pageNumber?.toString() || '',
            item.reviewStatus,
          ]);
        });

        const tradeSheet = XLSX.utils.aoa_to_sheet(tradeData);
        tradeSheet['!cols'] = [
          { wch: 20 },
          { wch: 50 },
          { wch: 10 },
          { wch: 8 },
          { wch: 30 },
          { wch: 6 },
          { wch: 10 },
        ];

        XLSX.utils.book_append_sheet(
          workbook,
          tradeSheet,
          (trade?.name || code).substring(0, 31) // Excel limits sheet names to 31 chars
        );
      });
    }

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Create filename
    const safeName = bid.title
      .replace(/[^a-zA-Z0-9]/g, '_')
      .substring(0, 50);
    const filename = `${safeName}_line_items_${new Date().toISOString().split('T')[0]}.xlsx`;

    // Return file
    return new NextResponse(buffer, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
