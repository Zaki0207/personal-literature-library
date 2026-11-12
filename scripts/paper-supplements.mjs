import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NotFoundError, ValidationError } from "./library-repository.mjs";

const MAX_MIB = 500;
const MAX_BYTES = MAX_MIB * 1024 * 1024;

function assertFileSize(size) {
  if (size <= MAX_BYTES) return;
  const error = new ValidationError(`每份补充材料最多 ${MAX_MIB} MiB。`);
  error.statusCode = 413;
  throw error;
}

function assertFileName(name) {
  if (typeof name !== "string" || !name.trim() || !name.isWellFormed() ||
    name === "." || name === ".." || /[\\/\p{Cc}]/u.test(name) || Buffer.byteLength(name) > 255) {
    throw new ValidationError("补充材料文件名无效或过长。");
  }
}

function assertSupplementId(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) {
    throw new ValidationError("补充材料 ID 无效。");
  }
}

async function cleanDirectory(directory) {
  await rm(directory, { recursive: true, force: true }).catch((error) => {
    console.error("[paper-supplements] 无法清理归档目录。", error.message);
  });
}

export class PaperSupplementsService {
  constructor(repository) {
    this.repository = repository;
    this.directory = join(dirname(repository.dbPath), "supplements");
  }

  async importLocalFile(paperId, filePath) {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    let input;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ValidationError("请选择本地文件。");
      input = file.createReadStream();
      return await this.importFile(paperId, basename(filePath), input, info.size);
    } finally {
      input?.destroy();
      await file.close();
    }
  }

  async importFile(paperId, name, input, contentLength = 0) {
    assertFileName(name);
    assertFileSize(contentLength);
    if (!this.repository.getPaper(paperId)) throw new NotFoundError("未找到论文。");

    const id = randomUUID();
    const directory = join(this.directory, id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    let committed = false;
    try {
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const validate = new Transform({
        transform(chunk, _encoding, callback) {
          sizeBytes += chunk.length;
          try { assertFileSize(sizeBytes); }
          catch (error) { callback(error); return; }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(input, validate, createWriteStream(join(directory, name), { flags: "wx", mode: 0o600, flush: true }));
      const result = await this.repository.recordPaperSupplement(paperId, {
        id, name, sizeBytes, sha256: hash.digest("hex"),
      });
      committed = !result.alreadyImported;
      return result;
    } finally {
      if (!committed) await cleanDirectory(directory);
    }
  }

  async getLocalFile(paperId, id) {
    assertSupplementId(id);
    const record = this.repository.getPaperSupplement(paperId, id);
    if (!record) throw new NotFoundError("未找到这篇论文的补充材料。");
    assertFileName(record.name);
    try {
      const directory = await realpath(this.directory);
      const target = join(directory, id, record.name);
      const [path, info] = await Promise.all([realpath(target), lstat(target)]);
      if (dirname(path) === join(directory, id) && info.isFile()) {
        return { path, name: record.name, sizeBytes: info.size };
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    throw new NotFoundError("本地补充材料文件不可用，请移除该条目后重新添加。");
  }

  async remove(paperId, id) {
    assertSupplementId(id);
    const { removed, ...result } = await this.repository.deletePaperSupplement(paperId, id);
    if (removed) await cleanDirectory(join(this.directory, id));
    return result;
  }
}
