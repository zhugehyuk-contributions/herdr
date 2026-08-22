/**
 * A throwaway sshd, owned by the test.
 *
 * ⚠️ Two things this must never do, and does not:
 *
 *   1. **Touch the developer's ssh configuration.** No key of theirs is read, `~/.ssh` is not
 *      written, and `authorized_keys` is not appended to. The daemon below has its own host key,
 *      its own `authorized_keys` and its own port, all generated into a scratch directory and
 *      deleted afterwards. The alternative — connecting to the machine's real sshd with the user's
 *      own private key — would work, and would mean a test suite that reads private keys.
 *   2. **Match processes by name.** The developer runs long-lived `herdr` daemons; this file (like
 *      `test/live/harness.ts`) signals only pids it spawned itself. No `pkill`, no `killall`.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Where `sshd` lives. It is not on a normal `PATH` on macOS, hence the explicit candidates. */
const SSHD_CANDIDATES = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"];

export function findSshd(): string | null {
  const override = process.env["HERDR_LIVE_SSHD"];
  if (override !== undefined) {
    return existsSync(override) ? override : null;
  }
  return SSHD_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export interface ScratchSshd {
  port: number;
  username: string;
  privateKeyPath: string;
  hostKeyPath: string;
  pid: number;
  stop: () => Promise<void>;
}

/** An unused TCP port, obtained by binding one and letting go. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        rejectPort(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number, dead: () => string | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolveReachable) => {
      const probe = new Socket();
      probe.setTimeout(500);
      probe.once("connect", () => {
        probe.destroy();
        resolveReachable(true);
      });
      probe.once("error", () => resolveReachable(false));
      probe.once("timeout", () => {
        probe.destroy();
        resolveReachable(false);
      });
      probe.connect(port, "127.0.0.1");
    });
    if (reachable) {
      return;
    }
    const exited = dead();
    if (exited !== null) {
      throw new Error(`sshd exited before it listened on ${port}: ${exited}`);
    }
    await delay(50);
  }
  throw new Error(`sshd never listened on 127.0.0.1:${port} within ${timeoutMs}ms`);
}

/**
 * Starts an sshd that accepts exactly one generated key, as the current user, on a scratch port.
 *
 * `-D` (no fork) is what makes teardown precise: the spawned pid *is* the daemon, so
 * {@link ScratchSshd.stop} signals it directly instead of chasing a pid file.
 */
export async function spawnScratchSshd(sshdPath: string, base: string): Promise<ScratchSshd> {
  const dir = join(base, "sshd");
  mkdirSync(dir, { recursive: true });

  const hostKeyPath = join(dir, "host_key");
  const clientKeyPath = join(dir, "client_key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath, "-C", "herdr-ts-live"]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKeyPath, "-C", "herdr-ts-live"]);
  const authorizedKeys = join(dir, "authorized_keys");
  copyFileSync(`${clientKeyPath}.pub`, authorizedKeys);

  const port = await freePort();
  const configPath = join(dir, "sshd_config");
  const config = [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKeyPath}`,
    `AuthorizedKeysFile ${authorizedKeys}`,
    // The scratch dir is under /tmp and cannot satisfy StrictModes' ownership rules.
    "StrictModes no",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "PermitUserEnvironment no",
    "PrintMotd no",
    "LogLevel ERROR",
    "",
  ].join("\n");
  writeFileSync(configPath, config);

  const child: ChildProcess = spawn(sshdPath, ["-D", "-e", "-f", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  let exited: { code: number | null; signal: string | null } | null = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`failed to spawn ${sshdPath}`);
  }

  const stop = async (): Promise<void> => {
    if (exited === null) {
      // Only the pid this harness created.
      child.kill("SIGTERM");
      for (let i = 0; i < 100 && exited === null; i += 1) {
        await delay(20);
      }
      if (exited === null) {
        child.kill("SIGKILL");
        await delay(200);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitForPort(port, 15_000, () =>
      exited === null ? null : `code=${(exited as { code: number | null }).code} log:\n${log}`,
    );
  } catch (error) {
    await stop();
    throw error;
  }

  return { port, username: userInfo().username, privateKeyPath: clientKeyPath, hostKeyPath, pid, stop };
}
