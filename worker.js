const db = require("./db");
const { createWholePaperWorker } = require("./lib/whole-paper-worker");

const worker = createWholePaperWorker({ db });

db.initDatabase()
  .then(() => {
    worker.start();
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
