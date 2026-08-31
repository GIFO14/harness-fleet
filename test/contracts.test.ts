import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateContracts } from "@harness-fleet/core";

const roots: string[] = [];
async function root() { const path = join(tmpdir(), `harness-fleet-contract-${randomUUID()}`); roots.push(path); await mkdir(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });
describe("attempt contracts", () => {
  it("validates JSON Schema and real YAML", async () => {
    const dir = await root(); const started = Date.now() - 100;
    await writeFile(join(dir, "result.json"), JSON.stringify({ ok: true }));
    await writeFile(join(dir, "result.yaml"), "name: demo\nitems:\n  - one\n");
    const results = await validateContracts(dir, [
      { path: "result.json", kind: "json-schema", required: true, schema: { type: "object", required: ["ok"], properties: { ok: { const: true } } } },
      { path: "result.yaml", kind: "yaml", required: true },
    ], started);
    expect(results.every((x) => x.ok)).toBe(true);
  });
  it("rejects stale artifacts from an earlier attempt", async () => {
    const dir = await root(); const file = join(dir, "old.md"); await writeFile(file, "old");
    await utimes(file, new Date(0), new Date(0));
    expect((await validateContracts(dir, [{ path: "old.md", kind: "markdown", required: true }], Date.now()))[0].ok).toBe(false);
  });
  it("blocks path traversal", async () => {
    const dir = await root();
    expect((await validateContracts(dir, [{ path: "../secret", kind: "file-exists", required: true }], Date.now()))[0].detail).toMatch(/escapes/);
  });
});
