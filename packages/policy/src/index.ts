import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BridgeError, objectiveHash } from "../../protocol/src/index.ts";
import type { Capability, DelegationHop, SubmitTaskInput } from "../../protocol/src/index.ts";

function nearestExisting(path: string): { realParent: string; suffix: string[] } {
  const suffix: string[] = []; let cursor = path;
  while (true) {
    try { return { realParent: realpathSync(cursor), suffix }; }
    catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new BridgeError("PATH_NOT_FOUND", "路径及其父目录不存在", false, { path });
      suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); cursor = parent;
    }
  }
}

function resolvedFuture(path: string): string {
  const { realParent, suffix } = nearestExisting(path);
  return resolve(realParent, ...suffix);
}

function within(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveWorkspace(path: string): string {
  if (!isAbsolute(path)) throw new BridgeError("WORKSPACE_MUST_BE_ABSOLUTE", "workspaceRoot 必须是绝对路径");
  let real: string;
  try { real = realpathSync(path); } catch { throw new BridgeError("WORKSPACE_NOT_FOUND", "workspaceRoot 不存在", false, { path }); }
  if (!statSync(real).isDirectory()) throw new BridgeError("WORKSPACE_NOT_DIRECTORY", "workspaceRoot 必须是目录");
  return real;
}

export function assertWritePath(requestedPath: string, workspaceRoot: string, allowedWriteRoots: string[]): string {
  if (!requestedPath || requestedPath.includes("\0")) throw new BridgeError("INVALID_PATH", "路径为空或包含 NUL");
  const workspace = resolveWorkspace(workspaceRoot);
  const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(workspace, requestedPath);
  const candidate = resolvedFuture(absolute);
  const roots = allowedWriteRoots.map((root) => resolvedFuture(isAbsolute(root) ? root : resolve(workspace, root)));
  if (!roots.some((root) => within(candidate, root))) {
    throw new BridgeError("PATH_OUTSIDE_ALLOWED_ROOT", "目标路径不在允许写入目录中", false, { requestedPath, resolvedPath: candidate });
  }
  try {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      const real = realpathSync(absolute);
      if (!roots.some((root) => within(real, root))) throw new BridgeError("PATH_OUTSIDE_ALLOWED_ROOT", "符号链接目标越界", false, { requestedPath, realPath: real });
      return real;
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
  }
  return candidate;
}

export function requireCapability(granted: Capability[], required: Capability): void {
  if (!granted.includes(required)) throw new BridgeError("CAPABILITY_DENIED", `任务未授予 ${required} capability`, false, { required, granted });
}

export function validateTaskPolicy(task: SubmitTaskInput): { workspace: string; objectiveHash: string } {
  const workspace = resolveWorkspace(task.workspaceRoot);
  if (task.allowedWriteRoots.length > 0) requireCapability(task.capabilities, "write_files");
  for (const root of task.allowedWriteRoots) assertWritePath(root, workspace, task.allowedWriteRoots);
  for (const artifact of task.artifacts?.expected ?? []) {
    requireCapability(task.capabilities, "write_files");
    if (artifact.kind === "image") requireCapability(task.capabilities, "image_generate");
    assertWritePath(resolve(artifact.directory, artifact.suggestedName), workspace, task.allowedWriteRoots);
    if (artifact.overwrite === "overwrite") throw new BridgeError("APPROVAL_REQUIRED", "覆盖已有文件需要单独审批", false, { path: resolve(artifact.directory, artifact.suggestedName) });
  }
  const hash = objectiveHash(task.objective, task.inputs);
  const depth = task.delegationDepth ?? 0; const max = task.limits?.maxDelegationDepth ?? 3;
  if (depth > max) throw new BridgeError("DELEGATION_LOOP_DETECTED", "已超过最大委派深度", false, { depth, max });
  const chain = task.delegationChain ?? [];
  if (chain.some((hop) => hop.source === task.sourceAgent && hop.target === task.targetAgent && hop.objectiveHash === hash)) {
    throw new BridgeError("DELEGATION_LOOP_DETECTED", "检测到无进展的重复委派", false, { depth, hash });
  }
  return { workspace, objectiveHash: hash };
}

export function nextDelegation(task: SubmitTaskInput): { depth: number; chain: DelegationHop[]; originTaskId?: string } {
  return { depth: (task.delegationDepth ?? 0) + 1, chain: [...(task.delegationChain ?? []), { source: task.sourceAgent, target: task.targetAgent, objectiveHash: objectiveHash(task.objective, task.inputs) }], originTaskId: task.originTaskId };
}

export function highRiskAction(action: { kind: string; path?: string }): boolean {
  return ["delete", "overwrite", "privileged_shell", "network", "outside_workspace_write"].includes(action.kind);
}
