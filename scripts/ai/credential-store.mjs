import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_KEYCHAIN_SERVICE =
  "com.personal-literature-library.ai";

const DEFAULT_HELPER_SOURCE = fileURLToPath(
  new URL("./keychain-helper.swift", import.meta.url),
);
const DEFAULT_HELPER_BINARY = join(
  homedir(),
  "Library",
  "Application Support",
  "个人文献库",
  "bin",
  "keychain-helper-v1",
);

export class CredentialStoreError extends Error {
  constructor(message, code = "KEYCHAIN_COMMAND_FAILED") {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

function validateAccount(account) {
  if (typeof account !== "string" || !/^[a-z0-9-]{1,64}$/.test(account)) {
    throw new CredentialStoreError("钥匙串账户名称无效。", "INVALID_ACCOUNT");
  }
  return account;
}

function isNotFoundExit(code) {
  return code === 44;
}

function runChildProcess(
  spawnImpl,
  command,
  args,
  { stdinValue, allowNotFound = false, timeoutMs = 30_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let outputBytes = 0;
    const maxOutputBytes = 65_536;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new CredentialStoreError(
            "macOS 钥匙串操作超时。",
            "KEYCHAIN_TIMEOUT",
          ),
        ),
      );
    }, timeoutMs);

    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= maxOutputBytes) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      finish(() =>
        reject(
          new CredentialStoreError(
            "无法启动 macOS 钥匙串辅助程序。",
            error?.code ?? "KEYCHAIN_SPAWN_FAILED",
          ),
        ),
      );
    });
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
          return;
        }
        if (allowNotFound && isNotFoundExit(code)) {
          resolve(null);
          return;
        }
        reject(
          new CredentialStoreError(
            "macOS 钥匙串操作失败。",
            `KEYCHAIN_EXIT_${code ?? "UNKNOWN"}`,
          ),
        );
      });
    });

    if (stdinValue === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdinValue);
    }
  });
}

async function fileMtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export class MacOsKeychainCredentialStore {
  constructor({
    serviceName = DEFAULT_KEYCHAIN_SERVICE,
    spawnImpl = spawn,
    platform = process.platform,
    helperSourcePath = DEFAULT_HELPER_SOURCE,
    helperBinaryPath = DEFAULT_HELPER_BINARY,
    compileHelper = true,
  } = {}) {
    this.serviceName = serviceName;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.helperSourcePath = helperSourcePath;
    this.helperBinaryPath = helperBinaryPath;
    this.compileHelper = compileHelper;
    this.helperPromise = null;
  }

  #assertAvailable() {
    if (this.platform !== "darwin") {
      throw new CredentialStoreError(
        "当前系统不支持 macOS 钥匙串。",
        "KEYCHAIN_UNSUPPORTED_PLATFORM",
      );
    }
  }

  async #buildHelper() {
    if (!this.compileHelper) return this.helperBinaryPath;
    const [sourceMtime, binaryMtime] = await Promise.all([
      fileMtime(this.helperSourcePath),
      fileMtime(this.helperBinaryPath),
    ]);
    if (sourceMtime === null) {
      throw new CredentialStoreError(
        "缺少 macOS 钥匙串辅助程序源码。",
        "KEYCHAIN_HELPER_SOURCE_MISSING",
      );
    }
    if (binaryMtime !== null && binaryMtime >= sourceMtime) {
      return this.helperBinaryPath;
    }

    await mkdir(dirname(this.helperBinaryPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryPath = `${this.helperBinaryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await runChildProcess(
        this.spawnImpl,
        "/usr/bin/xcrun",
        ["swiftc", this.helperSourcePath, "-O", "-o", temporaryPath],
        { timeoutMs: 120_000 },
      );
      await chmod(temporaryPath, 0o700);
      await rename(temporaryPath, this.helperBinaryPath);
      return this.helperBinaryPath;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError(
        "无法编译 macOS 钥匙串辅助程序。",
        error?.code ?? "KEYCHAIN_HELPER_BUILD_FAILED",
      );
    }
  }

  async #helper() {
    this.#assertAvailable();
    if (!this.helperPromise) {
      this.helperPromise = this.#buildHelper().catch((error) => {
        this.helperPromise = null;
        throw error;
      });
    }
    return this.helperPromise;
  }

  async #run(action, account, options = {}) {
    const helper = await this.#helper();
    return runChildProcess(
      this.spawnImpl,
      helper,
      [action, this.serviceName, validateAccount(account)],
      options,
    );
  }

  async has(account) {
    const value = await this.#run("has", account, { allowNotFound: true });
    return value !== null;
  }

  async get(account) {
    const value = await this.#run("get", account, { allowNotFound: true });
    return value === null ? null : value.toString("utf8");
  }

  async set(account, secret) {
    if (typeof secret !== "string" || !secret.trim()) {
      throw new CredentialStoreError("API Key 不能为空。", "EMPTY_SECRET");
    }
    await this.#run("set", account, { stdinValue: secret.trim() });
  }

  async delete(account) {
    await this.#run("delete", account, { allowNotFound: true });
  }
}

export class MemoryCredentialStore {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  async has(account) {
    return this.values.has(account);
  }

  async get(account) {
    return this.values.get(account) ?? null;
  }

  async set(account, secret) {
    this.values.set(account, secret);
  }

  async delete(account) {
    this.values.delete(account);
  }
}
