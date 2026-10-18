import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getEnv } from "@/lib/env";

export type Archive = {
  ensureBucket(): Promise<void>;
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  ping(): Promise<boolean>;
};

export type ArchiveOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const PING_TIMEOUT_MS = 3000;

/** SeaweedFS and AWS differ in error names, so match on name and HTTP status. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.name === "NoSuchBucket" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export function createArchive(opts: ArchiveOptions): Archive {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const Bucket = opts.bucket;

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      try {
        await client.send(new CreateBucketCommand({ Bucket }));
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
      }
    },

    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return (await res.Body?.transformToByteArray()) ?? null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async ping() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }), {
          abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

let cached: Archive | undefined;

/** Memoized archive configured from the environment. */
export function getArchive(): Archive {
  if (!cached) {
    const env = getEnv();
    cached = createArchive({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }
  return cached;
}
