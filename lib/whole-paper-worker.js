const { gradeWholePaper } = require("./ai-grader");

// The HTTP handler receives this process-local capability explicitly. Serverless
// handlers never start this loop and therefore cannot promise background work.
function createWholePaperWorker({
  db, grade = gradeWholePaper, pollMs = 1000, heartbeatMs = 30000,
  taskTimeoutMs = 15 * 60 * 1000, onError = (error) => console.error("Whole-paper worker:", error.message),
}) {
  let stopped = true, busy = false, timer, controller, lastHealthyAt = 0;

  async function runJob(job) {
    const abortController = new AbortController();
    controller = abortController;
    let heartbeat, finished = false;
    const deadline = setTimeout(() => abortController.abort(), taskTimeoutMs);
    const renew = async () => {
      try {
        if (!(await db.renewWholePaperLease(job))) {
          lastHealthyAt = 0;
          abortController.abort();
          return;
        }
        lastHealthyAt = Date.now();
      } catch (error) {
        lastHealthyAt = 0;
        abortController.abort();
        onError(error);
        return;
      }
      if (!finished) heartbeat = setTimeout(renew, heartbeatMs);
    };
    heartbeat = setTimeout(renew, heartbeatMs);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error("批改任务超时、租约丢失或服务正在停止，请重试。"));
      abortController.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const work = async () => {
        const payload = await db.getWholePaperJobPayload(job);
        if (abortController.signal.aborted) throw new Error("任务已取消。");
        return grade({ ...payload, signal: abortController.signal });
      };
      const result = await Promise.race([work(), aborted]);
      // Fenced completion atomically writes ALL questions and the terminal status.
      await db.completeWholePaperJob(job, result);
    } catch (error) {
      await db.failWholePaperJob(job, error.message);
    } finally {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(heartbeat);
      abortController.signal.removeEventListener("abort", onAbort);
      if (controller === abortController) controller = null;
    }
  }

  async function runOnce() {
    if (busy) return false;
    busy = true;
    try {
      await db.recoverWholePaperJobs();
      const job = await db.claimWholePaperJob();
      lastHealthyAt = Date.now();
      if (job) await runJob(job);
      return Boolean(job);
    } catch (error) {
      lastHealthyAt = 0;
      onError(error);
      return false;
    } finally {
      busy = false;
    }
  }

  async function tick() {
    if (stopped) return;
    await runOnce();
    if (!stopped) timer = setTimeout(tick, pollMs);
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(tick, 0);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
    isAvailable() {
      return !stopped && lastHealthyAt > 0 && Date.now() - lastHealthyAt < 90000;
    },
  };
}

module.exports = { createWholePaperWorker };
