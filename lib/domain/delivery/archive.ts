import { getArchive, type Archive } from "@/lib/adapters/s3";

/*
 * The one archive seam of deliveries (ruling M6-P18): the build job and the API routes store and read packages through
 * `deliveryArchive()`. It resolves the S3 archive on first use, never at import, so a page or route importing this
 * module builds without an environment.
 */

let installed: Archive | null = null;

/** The archive packages are stored in: the one `setDeliveryArchive` installed, else the S3 archive of the environment. */
export function deliveryArchive(): Archive {
  return installed ?? getArchive();
}

/** Test seam; pass null to restore the S3 archive. */
export function setDeliveryArchive(archive: Archive | null): void {
  installed = archive;
}
