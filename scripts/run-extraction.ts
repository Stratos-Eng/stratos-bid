import { runExtractionLoop } from '../src/extraction/agentic';

const bidFolder = process.argv[2] || '/Users/hamza/Downloads/ESFV LRT (Metro) - FFP 02 Maintenance Facility';

const documents = [
  { id: 'metro-signage', name: 'Metro Signage Package', path: bidFolder }
];

async function main() {
  console.log(`Starting extraction on: ${bidFolder}`);

  const result = await runExtractionLoop(bidFolder, documents);

  console.log('\n=== EXTRACTION COMPLETE ===');
  console.log('Entries found:', result.entries.length);
  console.log('Total count:', result.totalCount);
  console.log('Confidence:', result.confidence);
  console.log('Iterations:', result.iterationsUsed);
  console.log('Tool calls:', result.toolCallsCount);
  console.log('Token usage:', result.tokenUsage);
  console.log('\n=== ENTRIES ===');
  result.entries.forEach((e, i) => {
    console.log(`${i+1}. ${e.name} (${e.roomNumber || 'no room#'}) - qty: ${e.quantity}, type: ${e.signTypeCode || 'N/A'}`);
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
