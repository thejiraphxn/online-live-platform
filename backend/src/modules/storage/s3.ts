import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';

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
  await s3
    .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
    .catch(() => {});
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

export { s3, PutObjectCommand };
