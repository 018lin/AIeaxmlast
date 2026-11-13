const db = require("./db");
const { createWholePaperWorker } = require("./lib/whole-paper-worker");

const worker = createWholePaperWorker({ db });

async function heartbeat() {
  try {
    if (!worker.isAvailable()) return;
    await db.touchWorkerHeartbeat();
  } catch (error) {
    console.error(`[worker] heartbeat failed: ${error.message}`);
  }
}

db.initDatabase()
  .then(() => {
    worker.start();
    heartbeat();
    setInterval(heartbeat, 20000).unref();
    console.log(`[worker] started, pid=${process.pid}`);
  })
  .catch((error) => {
    console.error(`[worker] database init failed: ${error.message}`);
    process.exit(1);
  });

setInterval(() => {
  console.log(`[worker] healthy=${worker.isAvailable()}`);
}, 60000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    console.log(`[worker] ${signal} received, stopping`);
    worker.stop();
    setTimeout(() => process.exit(0), 200);
  });
}
