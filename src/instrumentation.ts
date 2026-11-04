export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRetentionLoop } = await import("./server/retention");
    const { getDb } = await import("./server/db/client");
    startRetentionLoop(getDb);
  }
}
