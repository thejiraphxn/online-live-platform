/**
 * One-shot: find READY/PROCESSING recordings that should be re-transcoded
 * and enqueue them again. Useful after changing the transcode pipeline.
 *
 *   pnpm tsx scripts/requeue-stuck.ts            # only status=PROCESSING
 *   pnpm tsx scripts/requeue-stuck.ts --all      # also re-transcode READY
 */
import 'dotenv/config';
import '../src/lib/bigint.js';
import { prisma } from '../src/lib/prisma.js';
import { recordingQueue } from '../src/jobs/queue.js';

const reprocessReady = process.argv.includes('--all');

async function main() {
  const rows = await prisma.sessionRecording.findMany({
    where: reprocessReady
      ? { rawKey: { not: null }, OR: [{ status: 'PROCESSING' }, { status: 'READY' }, { status: 'FAILED' }] }
      : { rawKey: { not: null }, OR: [{ status: 'PROCESSING' }, { status: 'FAILED' }] },
    select: { id: true, status: true, sessionId: true },
  });
  console.log(`found ${rows.length} recording(s) to re-enqueue`);
  for (const r of rows) {
    await prisma.sessionRecording.update({
      where: { id: r.id },
      data: { status: 'PROCESSING', errorMessage: null },
    });
    await recordingQueue.add(
      'process',
      { recordingId: r.id },
      { jobId: `rec-${r.id}-requeue-${Date.now()}` },
    );
    console.log(`  enqueued ${r.id} (was ${r.status})`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
