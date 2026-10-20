import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createArchive, type Archive } from "@/lib/adapters/s3";
import { getEnv } from "@/lib/env";

export function testArchiveOptions() {
  const env = getEnv();
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_TEST_BUCKET ?? "periplus-test",
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
}

let cached: Archive | undefined;

/** Archive bound to the test bucket (created on first use). */
export function testArchive(): Archive {
  cached ??= createArchive(testArchiveOptions());
  return cached;
}

/** A client on the test bucket for what the archive adapter does not offer (cleanup, object metadata). */
function testClient(): { client: S3Client; bucket: string } {
  const o = testArchiveOptions();
  const client = new S3Client({
    endpoint: o.endpoint,
    region: o.region,
    forcePathStyle: true,
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
  });
  return { client, bucket: o.bucket };
}

/** Deletes `keys` from the test bucket (a test that wrote to it cleans up after itself). */
export async function deleteTestObjects(keys: string[]): Promise<void> {
  const { client, bucket } = testClient();
  try {
    for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
  } finally {
    client.destroy();
  }
}

/** The stored `Content-Type` of a key in the test bucket. */
export async function testObjectContentType(key: string): Promise<string | undefined> {
  const { client, bucket } = testClient();
  try {
    return (await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentType;
  } finally {
    client.destroy();
  }
}

/**
 * In-memory archive with its keys and content types exposed: no persisted object turns a first import into a silent
 * reuse.
 */
export function memoryArchive(): Archive & { keys(): string[]; contentType(key: string): string | undefined } {
  const store = new Map<string, Uint8Array>();
  const types = new Map<string, string>();
  return {
    async ensureBucket() {},
    async put(key, body, contentType) {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
      types.set(key, contentType);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async exists(key) {
      return store.has(key);
    },
    async ping() {
      return true;
    },
    keys: () => [...store.keys()].sort(),
    contentType: (key) => types.get(key),
  };
}
