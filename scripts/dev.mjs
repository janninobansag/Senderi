import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = [
  {
    name: "API",
    directory: "server",
    command: ["node_modules/tsx/dist/cli.mjs", "watch", "src/index.ts"],
  },
  {
    name: "Client",
    directory: "client",
    command: ["node_modules/vite/bin/vite.js"],
  },
];

let stopping = false;
const children = new Set();

for (const project of projects) {
  console.info(`Starting Senderi ${project.name.toLowerCase()}...`);
  const child = spawn(process.execPath, project.command, {
    cwd: resolve(rootDirectory, project.directory),
    detached: process.platform !== "win32",
    stdio: "inherit",
    windowsHide: true,
  });
  children.add(child);

  child.on("error", (error) => {
    console.error(`Could not start the Senderi ${project.name.toLowerCase()}: ${error.message}`);
    process.exitCode = 1;
    stopChildren("SIGTERM");
  });
  child.on("close", (code, signal) => {
    children.delete(child);
    const result = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    console.info(`Senderi ${project.name.toLowerCase()} stopped (${result}).`);
    if (code && code !== 0) process.exitCode = code;

    // Keep the local environment together if either service stops unexpectedly.
    if (!stopping) stopChildren("SIGTERM");
  });
}

function stopChildren(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    } else {
      child.kill(signal);
    }
  }
}

process.once("SIGINT", () => {
  process.exitCode = 130;
  stopChildren("SIGINT");
});
process.once("SIGTERM", () => {
  process.exitCode = 143;
  stopChildren("SIGTERM");
});
