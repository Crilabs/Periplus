import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { Writable } from "node:stream";
import { createDb } from "../lib/db/client";
import { createUser, disableUser, setPassword } from "../lib/domain/users";

/** Reads one line from stdin without echoing it; works for TTY and piped input. */
function readSecret(prompt: string): Promise<string> {
  const tty = Boolean(process.stdin.isTTY);
  if (tty) process.stderr.write(prompt);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: tty });
  return new Promise((resolve, reject) => {
    let done = false;
    rl.once("line", (line) => {
      done = true;
      if (tty) process.stderr.write("\n");
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      if (!done) reject(new Error("no password provided on stdin"));
    });
  });
}

async function main(): Promise<void> {
  const [command, email] = process.argv.slice(2);
  if ((command !== "create" && command !== "password" && command !== "disable") || !email) {
    throw new Error("usage: user.ts <create|password|disable> <email>");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const password = command === "disable" ? "" : await readSecret("Password: ");
  const { db, close } = createDb(url);
  try {
    if (command === "disable") {
      await disableUser(db, email);
      process.stdout.write("disabled\n");
    } else if (command === "create") {
      await createUser(db, email, password);
      process.stdout.write("created\n");
    } else {
      await setPassword(db, email, password);
      process.stdout.write("updated\n");
    }
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
