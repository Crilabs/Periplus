import { requireAdmin } from "@/lib/security/require-admin";

// Placeholder; replaced in a later task.
export default async function Page() {
  await requireAdmin();
  return <h1>Kosten</h1>;
}
