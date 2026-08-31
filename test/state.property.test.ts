import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { transitionNode } from "@harness-fleet/core";
import type { NodeRuntime } from "@harness-fleet/core";

describe("node state properties", () => {
  it("never permits an arbitrary transition out of completed", () => {
    fc.assert(fc.property(fc.constantFrom("ready", "running", "failed", "cancelled", "needs_attention", "waiting"), (status) => {
      const node = { status: "completed", attempt: 1, iteration: 0, lgtmCount: 0, spec: {} } as NodeRuntime;
      expect(() => transitionNode(node, status as any)).toThrow();
    }));
  });
});
