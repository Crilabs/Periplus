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

/** In-memory archive with its keys exposed: no persisted object turns a first import into a silent reuse. */
export function memoryArchive(): Archive & { keys(): string[] } {
  const store = new Map<string, Uint8Array>();
  return {
    async ensureBucket() {},
    async put(key, body) {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
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
  };
}
