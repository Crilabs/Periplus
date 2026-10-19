import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60_000;
/** Longest text read from pdftotext: a PDF that expands beyond this is not a document we archive. */
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const NOT_INSTALLED = "pdftotext not installed (poppler-utils)";

/**
 * Text of a PDF with its layout kept (`pdftotext -layout -enc UTF-8 - -`, the PDF on stdin): columns stay
 * aligned with spaces, pages end with a form feed. A missing binary, a non-zero exit (unreadable or encrypted
 * PDF), a timeout and more than `maxOutputBytes` of text (default 20 MiB; the process is killed) are errors.
 */
export function runPdftotext(bytes: Uint8Array, opts: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<string> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let tooLong = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (tooLong) return;
      outBytes += chunk.byteLength;
      if (outBytes > maxOutputBytes) {
        tooLong = true;
        out.length = 0;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error(NOT_INSTALLED) : error);
    });
    child.on("close", (code, signal) => {
      if (tooLong) return reject(new Error(`pdftotext output exceeds ${maxOutputBytes} bytes`));
      if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
      const reason = signal ? `killed by ${signal} (timeout?)` : `exit code ${code}`;
      reject(new Error(`pdftotext failed: ${reason}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 500)}`));
    });
    // A PDF pdftotext rejects early closes stdin; the close handler reports the exit.
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(bytes));
  });
}

/** Whether the `pdftotext` binary can be started here. */
export function hasPdftotext(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("pdftotext", ["-v"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}
