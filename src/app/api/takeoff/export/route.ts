import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import {
  takeoffProjects,
  takeoffSheets,
  takeoffCategories,
  takeoffMeasurements,
} from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { exportProjectSchema, formatZodError } from '@/lib/validations/takeoff';

// GET /api/takeoff/export?projectId=xxx&format=csv|excel - Export takeoff data
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const params = {
      projectId: searchParams.get('projectId') || undefined,
      format: searchParams.get('format') || 'excel',
      includeImages: searchParams.get('includeImages') === 'true',
    };

    // Validate query params with Zod
    const validation = exportProjectSchema.safeParse(params);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { projectId, format } = validation.data;

    // Verify project ownership
    const [project] = await db
      .select()
      .from(takeoffProjects)
      .where(
        and(
          eq(takeoffProjects.id, projectId),
          eq(takeoffProjects.userId, session.user.id)
        )
      )
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Get sheets
    const sheets = await db
      .select()
      .from(takeoffSheets)
      .where(eq(takeoffSheets.projectId, projectId))
      .orderBy(takeoffSheets.pageNumber);

    const sheetMap = new Map(sheets.map((s) => [s.id, s]));
    const sheetIds = sheets.map((s) => s.id);

    // Get categories
    const categories = await db
      .select()
      .from(takeoffCategories)
      .where(eq(takeoffCategories.projectId, projectId))
      .orderBy(takeoffCategories.sortOrder);

    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Get all measurements
    let measurements: (typeof takeoffMeasurements.$inferSelect)[] = [];
    if (sheetIds.length > 0) {
      measurements = await db
        .select()
        .from(takeoffMeasurements)
        .where(inArray(takeoffMeasurements.sheetId, sheetIds));
    }

    if (format === 'csv') {
      // Generate CSV export
      const csvRows: string[] = [];

      // Header row
      csvRows.push(
        [
          'Category',
          'Type',
          'Quantity',
          'Unit',
          'Label',
          'Sheet',
          'Page',
          'Source',
          'Created',
        ].join(',')
      );

      // Data rows
      measurements.forEach((m) => {
        const category = categoryMap.get(m.categoryId);
        const sheet = sheetMap.get(m.sheetId);
        csvRows.push(
          [
            escapeCSV(category?.name || 'Unknown'),
            m.measurementType,
            m.quantity.toString(),
            m.unit,
            escapeCSV(m.label || ''),
            escapeCSV(sheet?.name || `Page ${sheet?.pageNumber || '?'}`),
            sheet?.pageNumber?.toString() || '',
            m.source,
            m.createdAt?.toISOString() || '',
          ].join(',')
        );
      });

      const csv = csvRows.join('\n');
      const safeName = project.name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const filename = `${safeName}_takeoff_${new Date().toISOString().split('T')[0]}.csv`;

      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // Excel export (default)
    const workbook = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ['Takeoff Export'],
      [''],
      ['Project Information'],
      ['Name', project.name],
      ['Client', project.clientName || 'N/A'],
      ['Address', project.address || 'N/A'],
      ['Unit System', project.defaultUnit === 'imperial' ? 'Imperial (ft, SF)' : 'Metric (m, sqm)'],
      [''],
      ['Export Information'],
      ['Total Sheets', sheets.length.toString()],
      ['Total Categories', categories.length.toString()],
      ['Total Measurements', measurements.length.toString()],
      ['Export Date', new Date().toLocaleString()],
      ['Exported By', session.user.email || 'Unknown'],
    ];

    // Add category summary
    summaryData.push(['']);
    summaryData.push(['Category Summary']);
    summaryData.push(['Category', 'Type', 'Count', 'Total Qty', 'Unit']);

    categories.forEach((cat) => {
      const catMeasurements = measurements.filter((m) => m.categoryId === cat.id);
      const totalQty = catMeasurements.reduce((sum, m) => sum + (m.quantity || 0), 0);
      summaryData.push([
        cat.name,
        cat.measurementType,
        catMeasurements.length.toString(),
        totalQty.toFixed(2),
        cat.measurementType === 'count' ? 'EA' : cat.measurementType === 'linear' ? 'LF' : 'SF',
      ]);
    });

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    summarySheet['!cols'] = [{ wch: 20 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    // All Measurements sheet
    const measurementsData = [
      ['Category', 'Type', 'Quantity', 'Unit', 'Label', 'Sheet', 'Page', 'Source', 'Created'],
    ];

    measurements.forEach((m) => {
      const category = categoryMap.get(m.categoryId);
      const sheet = sheetMap.get(m.sheetId);
      measurementsData.push([
        category?.name || 'Unknown',
        m.measurementType,
        m.quantity.toString(),
        m.unit,
        m.label || '',
        sheet?.name || `Page ${sheet?.pageNumber || '?'}`,
        sheet?.pageNumber?.toString() || '',
        m.source,
        m.createdAt?.toLocaleDateString() || '',
      ]);
    });

    const measurementsSheet = XLSX.utils.aoa_to_sheet(measurementsData);
    measurementsSheet['!cols'] = [
      { wch: 20 }, // Category
      { wch: 10 }, // Type
      { wch: 12 }, // Quantity
      { wch: 8 }, // Unit
      { wch: 20 }, // Label
      { wch: 25 }, // Sheet
      { wch: 6 }, // Page
      { wch: 10 }, // Source
      { wch: 12 }, // Created
    ];
    XLSX.utils.book_append_sheet(workbook, measurementsSheet, 'All Measurements');

    // Create per-category sheets for detailed breakdown
    categories.forEach((cat) => {
      const catMeasurements = measurements.filter((m) => m.categoryId === cat.id);
      if (catMeasurements.length === 0) return;

      const catData = [['Sheet', 'Page', 'Quantity', 'Unit', 'Label', 'Source']];

      catMeasurements.forEach((m) => {
        const sheet = sheetMap.get(m.sheetId);
        catData.push([
          sheet?.name || `Page ${sheet?.pageNumber || '?'}`,
          sheet?.pageNumber?.toString() || '',
          m.quantity.toString(),
          m.unit,
          m.label || '',
          m.source,
        ]);
      });

      // Add totals row
      const total = catMeasurements.reduce((sum, m) => sum + (m.quantity || 0), 0);
      catData.push(['', '', '', '', '', '']);
      catData.push(['TOTAL', '', total.toFixed(2), catMeasurements[0]?.unit || '', '', '']);

      const catSheet = XLSX.utils.aoa_to_sheet(catData);
      catSheet['!cols'] = [
        { wch: 25 }, // Sheet
        { wch: 6 }, // Page
        { wch: 12 }, // Quantity
        { wch: 8 }, // Unit
        { wch: 20 }, // Label
        { wch: 10 }, // Source
      ];

      // Limit sheet name to 31 characters (Excel limit)
      const sheetName = cat.name.substring(0, 31);
      XLSX.utils.book_append_sheet(workbook, catSheet, sheetName);
    });

    // Create per-sheet summary
    if (sheets.length > 1) {
      const sheetsData = [['Sheet', 'Page', 'Category', 'Type', 'Count', 'Total Qty', 'Unit']];

      sheets.forEach((sheet) => {
        const sheetMeasurements = measurements.filter((m) => m.sheetId === sheet.id);
        if (sheetMeasurements.length === 0) return;

        // Group by category
        const byCategory = new Map<string, typeof sheetMeasurements>();
        sheetMeasurements.forEach((m) => {
          const list = byCategory.get(m.categoryId) || [];
          list.push(m);
          byCategory.set(m.categoryId, list);
        });

        byCategory.forEach((catMeasurements, catId) => {
          const category = categoryMap.get(catId);
          const total = catMeasurements.reduce((sum, m) => sum + (m.quantity || 0), 0);
          sheetsData.push([
            sheet.name || `Page ${sheet.pageNumber}`,
            sheet.pageNumber?.toString() || '',
            category?.name || 'Unknown',
            category?.measurementType || '',
            catMeasurements.length.toString(),
            total.toFixed(2),
            catMeasurements[0]?.unit || '',
          ]);
        });
      });

      const sheetsSheet = XLSX.utils.aoa_to_sheet(sheetsData);
      sheetsSheet['!cols'] = [
        { wch: 25 }, // Sheet
        { wch: 6 }, // Page
        { wch: 20 }, // Category
        { wch: 10 }, // Type
        { wch: 8 }, // Count
        { wch: 12 }, // Total Qty
        { wch: 8 }, // Unit
      ];
      XLSX.utils.book_append_sheet(workbook, sheetsSheet, 'By Sheet');
    }

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Create filename
    const safeName = project.name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    const filename = `${safeName}_takeoff_${new Date().toISOString().split('T')[0]}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Takeoff export error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Helper to escape CSV values
function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
