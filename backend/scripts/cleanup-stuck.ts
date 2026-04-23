/**
 * One-shot cleanup: heal any stuck recording state.
 *
 *   pnpm tsx scripts/cleanup-stuck.ts         # dry-run: show what would happen
 *   pnpm tsx scripts/cleanup-stuck.ts --apply # actually do it
 *
 * Rules:
 *   - UPLOADING / PROCESSING with no rawKey → delete (can't recover)
 *   - UPLOADING / PROCESSING with rawKey → requeue for re-processing
 *   - FAILED without rawKey → delete (user should start fresh)
 *   - Session.status == LIVE but no UPLOADING/PROCESSING recording → revert to SCHEDULED
 */
import 'dotenv/config';
import '../src/lib/bigint.js';
import { prisma } from '../src/lib/prisma.js';
import { recordingQueue } from '../src/jobs/queue.js';

const apply = process.argv.includes('--apply');

async function main() {
  console.log(apply ? '⚙️  APPLYING cleanup…' : '🔎 Dry-run (pass --apply to execute)\n');

  // --- Stuck recordings ---
  const stuck = await prisma.sessionRecording.findMany({
    where: { status: { in: ['UPLOADING', 'PROCESSING'] } },
    select: {
      id: true,
      sessionId: true,
      status: true,
      rawKey: true,
      updatedAt: true,
    },
  });
  const failedNoRaw = await prisma.sessionRecording.findMany({
    where: { status: 'FAILED', rawKey: null },
    select: { id: true, sessionId: true },
  });

  // --- Sessions stuck LIVE ---
  const liveSessions = await prisma.courseSession.findMany({
    where: { status: 'LIVE' },
    select: { id: true, title: true, recording: { select: { status: true } } },
  });

  console.log(`stuck UPLOADING/PROCESSING recordings: ${stuck.length}`);
  for (const r of stuck) {
    console.log(
      `  - ${r.id} (${r.status}, rawKey=${r.rawKey ? 'yes' : 'NO'}, updatedAt=${r.updatedAt.toISOString()})`,
    );
  }
  console.log(`FAILED recordings without raw file: ${failedNoRaw.length}`);
  for (const r of failedNoRaw) console.log(`  - ${r.id}`);
  console.log(`sessions with status=LIVE: ${liveSessions.length}`);
  for (const s of liveSessions) console.log(`  - ${s.id} "${s.title}" (rec: ${s.recording?.status ?? 'none'})`);

  if (!apply) {
    console.log('\nRe-run with --apply to execute these actions.');
    await prisma.$disconnect();
    return;
  }

  let deleted = 0;
  let requeued = 0;
  let revertedSessions = 0;

  // Stuck recordings
  for (const r of stuck) {
    if (!r.rawKey) {
      await prisma.sessionRecording.delete({ where: { id: r.id } });
      await prisma.courseSession.update({
        where: { id: r.sessionId },
        data: { status: 'SCHEDULED', startedAt: null, endedAt: null },
      });
      deleted++;
    } else {
      await prisma.sessionRecording.update({
        where: { id: r.id },
        data: { status: 'PROCESSING', errorMessage: null },
      });
      await recordingQueue.add(
        'process',
        { recordingId: r.id },
        { jobId: `rec-${r.id}-cleanup-${Date.now()}` },
      );
      requeued++;
    }
  }

  // FAILED without raw
  for (const r of failedNoRaw) {
    await prisma.sessionRecording.delete({ where: { id: r.id } });
    deleted++;
  }

  // LIVE sessions with no active recording → revert to SCHEDULED
  for (const s of liveSessions) {
    const rec = s.recording?.status;
    if (rec !== 'UPLOADING' && rec !== 'PROCESSING') {
      await prisma.courseSession.update({
        where: { id: s.id },
        data: { status: 'SCHEDULED', startedAt: null, endedAt: null },
      });
      revertedSessions++;
    }
  }

  console.log(`\n✅ Done: deleted ${deleted}, requeued ${requeued}, reverted ${revertedSessions} sessions`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
