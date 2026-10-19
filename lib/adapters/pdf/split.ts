import { PDFDocument } from "pdf-lib";

/** One single-page PDF per requested page (1-based, in the given order); a page outside the document is an error. */
export async function splitPdfPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const count = source.getPageCount();
  const out: Uint8Array[] = [];
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > count) throw new RangeError(`page ${page} is not in the PDF (1-${count})`);
    const single = await PDFDocument.create();
    const [copy] = await single.copyPages(source, [page - 1]);
    single.addPage(copy);
    out.push(await single.save());
  }
  return out;
}
