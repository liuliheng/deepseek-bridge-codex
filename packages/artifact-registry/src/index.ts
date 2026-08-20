import { closeSync, createReadStream, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { inflateSync } from "node:zlib";
import { BridgeError, newId } from "../../protocol/src/index.ts";
import type { ArtifactManifest, AgentKind } from "../../protocol/src/index.ts";
import { assertWritePath } from "../../policy/src/index.ts";

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

function sniff(buffer: Buffer, path: string): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function imageMetadata(mime: string, buffer: Buffer): Record<string, unknown> {
  if (mime === "image/png") {
    if (buffer.length < 24 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") throw new BridgeError("ARTIFACT_INVALID_IMAGE", "PNG 缺少有效 IHDR");
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20), bitDepth = buffer[24], colorType = buffer[25], interlace = buffer[28];
    const idat: Buffer[] = []; let offset = 8, ended = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset), type = buffer.subarray(offset + 4, offset + 8).toString("ascii"), end = offset + 12 + length;
      if (end > buffer.length) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "PNG chunk 不完整");
      if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
      if (type === "IEND") { ended = true; break; } offset = end;
    }
    if (!ended || idat.length === 0) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "PNG 缺少 IDAT 或 IEND");
    let decoded: Buffer; try { decoded = inflateSync(Buffer.concat(idat)); } catch { throw new BridgeError("ARTIFACT_INVALID_IMAGE", "PNG 图像数据无法解压"); }
    const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    if (!channels[colorType] || width === 0 || height === 0) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "PNG 色彩类型或尺寸无效");
    if (interlace === 0) {
      const rowBytes = Math.ceil(width * channels[colorType] * bitDepth / 8);
      if (decoded.length !== height * (rowBytes + 1)) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "PNG 解码数据长度不正确");
    }
    return { width, height, bitDepth, colorType, decoded: true };
  }
  if (mime === "image/gif") {
    if (buffer[buffer.length - 1] !== 0x3b) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "GIF 缺少结束标记");
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), decoded: true };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1], length = buffer.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "JPEG 缺少结束标记");
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), decoded: true };
      }
      if (length < 2) break; offset += 2 + length;
    }
    throw new BridgeError("ARTIFACT_INVALID_IMAGE", "无法读取 JPEG 尺寸");
  }
  return {};
}

export async function registerArtifact(input: {
  taskId: string; path: string; workspaceRoot: string; allowedWriteRoots: string[]; creator: AgentKind; expectedKind?: "file" | "image";
}): Promise<ArtifactManifest> {
  const safe = assertWritePath(input.path, input.workspaceRoot, input.allowedWriteRoots);
  let real: string;
  try { real = realpathSync(safe); } catch { throw new BridgeError("ARTIFACT_NOT_FOUND", "产物文件不存在", false, { path: safe }); }
  const info = lstatSync(real);
  if (!info.isFile()) throw new BridgeError("ARTIFACT_NOT_REGULAR_FILE", "产物必须是普通文件", false, { path: real });
  if (info.size <= 0) throw new BridgeError("ARTIFACT_EMPTY", "产物文件为空", false, { path: real });
  const fd = openSync(real, "r"); let header = Buffer.alloc(Math.min(64 * 1024, info.size));
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  const mimeType = sniff(header, real); const extMime = MIME_BY_EXT[extname(real).toLowerCase()];
  if (extMime?.startsWith("image/") && mimeType !== extMime) throw new BridgeError("ARTIFACT_MIME_MISMATCH", "图片扩展名与内容不匹配", false, { expected: extMime, actual: mimeType });
  if (input.expectedKind === "image" && !mimeType.startsWith("image/")) throw new BridgeError("ARTIFACT_INVALID_IMAGE", "期望图片但检测到非图片文件", false, { mimeType });
  if (mimeType.startsWith("image/") && info.size > 100 * 1024 * 1024) throw new BridgeError("ARTIFACT_TOO_LARGE", "图片超过 100 MiB 解码验证上限");
  if (mimeType.startsWith("image/") && info.size > header.length) header = readFileSync(real);
  const metadata = mimeType.startsWith("image/") ? imageMetadata(mimeType, header) : {};
  if (input.expectedKind === "image" && metadata.decoded !== true) throw new BridgeError("ARTIFACT_IMAGE_DECODER_UNAVAILABLE", "当前版本不能解码验证该图片格式", false, { mimeType });
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => createReadStream(real).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject));
  return { id: newId("artifact"), taskId: input.taskId, absolutePath: real, mimeType, sizeBytes: statSync(real).size, sha256: hash.digest("hex"), creator: input.creator, createdAt: new Date().toISOString(), metadata };
}
