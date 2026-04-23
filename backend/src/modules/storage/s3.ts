import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
});

const publicS3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.publicEndpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
});

export const Bucket = config.s3.bucket;

export async function createMultipart(key: string) {
  const res = await s3.send(
    new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'video/webm' }),
  );
  return res.UploadId!;
}

export async function presignUploadPart(key: string, uploadId: string, partNumber: number) {
  const cmd = new UploadPartCommand({
    Bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(publicS3, cmd, { expiresIn: 60 * 15 });
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
) {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
}

export async function abortMultipart(key: string, uploadId: string) {
  // Best-effort cleanup — the upload may already be gone. Log instead of
  // swallowing so orphaned multiparts (which bill storage) surface in logs.
  await s3
    .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
    .catch((err) => logger.warn({ err, key, uploadId }, 'abortMultipart failed'));
}

export async function presignGet(key: string, expiresIn = 60 * 30) {
  return getSignedUrl(publicS3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
}

export async function presignPut(key: string, contentType: string, expiresIn = 60 * 5) {
  return getSignedUrl(
    publicS3,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
}

export async function headObject(key: string) {
  return s3.send(new HeadObjectCommand({ Bucket, Key: key }));
}

// S3 DeleteObjects caps at 1000 keys per request. Chunks + swallows
// per-object errors (already-gone keys) but logs batch-level failures.
export async function deleteObjects(keys: string[]) {
  const unique = Array.from(new Set(keys.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    } catch (err) {
      logger.warn({ err, batchSize: batch.length }, 'deleteObjects batch failed');
    }
  }
}

export { s3, PutObjectCommand };
