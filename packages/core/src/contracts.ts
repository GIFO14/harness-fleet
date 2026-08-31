import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import type { ContractResult, OutputContract } from "@harness-fleet/protocol";

function safePath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`contract path escapes attempt: ${path}`);
  return target;
}

export async function validateContracts(root: string, contracts: OutputContract[], attemptStartedAt: number, fallbackRoots: string[] = []): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const contract of contracts) {
    let lastError: unknown;
    let satisfied = false;
    for (const candidateRoot of [root, ...fallbackRoots]) try {
      const target = safePath(candidateRoot, contract.path);
      const info = await stat(target);
      const [actualRoot, actualTarget] = await Promise.all([realpath(candidateRoot), realpath(target)]); const actualRel = relative(actualRoot, actualTarget);
      if (isAbsolute(actualRel) || actualRel.startsWith("..")) throw new Error(`contract symlink escapes attempt: ${contract.path}`);
      if (!info.isFile()) throw new Error("not a regular file");
      if (info.mtimeMs + 1 < attemptStartedAt) throw new Error("artifact predates this attempt");
      const text = contract.kind === "file-exists" ? "" : await readFile(target, "utf8");
      if (contract.kind === "markdown" && !text.trim()) throw new Error("markdown is empty");
      if (contract.kind === "json") JSON.parse(text);
      if (contract.kind === "yaml") parseYaml(text);
      if (contract.kind === "json-schema") {
        const data = JSON.parse(text);
        if (!contract.schema) throw new Error("schema is missing");
        const valid = new (Ajv2020 as any)({ allErrors: true }).compile(contract.schema)(data);
        if (!valid) throw new Error("JSON does not satisfy schema");
      }
      if (contract.kind === "regex" && !new RegExp(contract.pattern ?? "").test(text)) throw new Error("pattern did not match");
      results.push({ contract, ok: true, detail: "satisfied by current attempt" });
      satisfied = true; break;
    } catch (error) { lastError = error; }
    if (!satisfied) results.push({ contract, ok: !contract.required, detail: lastError instanceof Error ? lastError.message : String(lastError) });
  }
  return results;
}
