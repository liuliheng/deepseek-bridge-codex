import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerArtifact } from "../packages/artifact-registry/src/index.ts";
import { BridgeError } from "../packages/protocol/src/index.ts";

test("产物 manifest 包含真实 MIME、尺寸、大小和 SHA-256", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-artifact-")); const out = join(root, "out"); mkdirSync(out); const png = join(out, "pixel.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const manifest = await registerArtifact({ taskId: "task-1", path: png, workspaceRoot: root, allowedWriteRoots: [out], creator: "codex", expectedKind: "image" });
  assert.equal(manifest.mimeType, "image/png"); assert.equal(manifest.metadata?.width, 1); assert.match(manifest.sha256, /^[0-9a-f]{64}$/); assert.ok(manifest.sizeBytes > 0);
  const fake = join(out, "fake.png"); writeFileSync(fake, "not an image");
  await assert.rejects(registerArtifact({ taskId: "task-1", path: fake, workspaceRoot: root, allowedWriteRoots: [out], creator: "codex", expectedKind: "image" }), (error: unknown) => error instanceof BridgeError);
});
