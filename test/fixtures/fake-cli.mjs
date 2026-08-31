const harness = process.argv[2];
if (process.argv.includes("--version")) {
  process.stdout.write(`${harness} fake 1.0.0\n`);
  process.exit(0);
}
if (process.argv.includes("auth") || process.argv.includes("login")) {
  process.stdout.write("authenticated\n");
  process.exit(0);
}
let handled = false;
process.stdin.on("data", (chunk) => {
  if (handled) return; handled = true; const input = chunk.toString("utf8");
  if (harness === "pi") {
    process.stdout.write(JSON.stringify({ type: "agent_start", sessionId: "pi-session" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { cost: { total: 0.01 } } } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
  } else if (harness === "claude") {
    process.stdout.write(JSON.stringify({ type: "system", session_id: "claude-session" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", session_id: "claude-session", result: "done", total_cost_usd: 0.02 }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-session" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
  }
  if (!input.includes("HOLD")) setTimeout(() => process.exit(0), 100);
});
setTimeout(() => process.exit(0), 10_000);
