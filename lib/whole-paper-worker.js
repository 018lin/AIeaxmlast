const { gradeQuestionGroups, gradeWholePaper } = require("./ai-grader");

// The HTTP handler receives this process-local capability explicitly. Serverless
// handlers never start this loop and therefore cannot promise background work.
function createWholePaperWorker({
  db, grade = gradeWholePaper, gradeGroups = gradeQuestionGroups,
  pollMs = 1000, heartbeatMs = 30000, taskTimeoutMs = 15 * 60 * 1000,
  concurrency = 6, perStudent = 2,
  onError = (error) => console.error("Whole-paper worker:", error.message),
}) {
  let stopped = true, legacyBusy = false, timer, lastHealthyAt = 0;
  const running = new Set();
  const controllers = new Set();

  async function execute(job, task) {
    const abortController = new AbortController();
    controllers.add(abortController);
    let heartbeat, finished = false;
    const deadline = setTimeout(() => abortController.abort(), taskTimeoutMs);
    const renew = async () => {
      try {
        if (!(await task.renew())) {
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
        const payload = await task.payload();
        if (abortController.signal.aborted) throw new Error("任务已取消。");
        return task.grade(payload, abortController.signal);
      };
      const result = await Promise.race([work(), aborted]);
      // Fenced completion atomically writes ALL results and the terminal status.
      await task.complete(result);
    } catch (error) {
      await task.fail(error.message);
    } finally {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(heartbeat);
      abortController.signal.removeEventListener("abort", onAbort);
      controllers.delete(abortController);
    }
  }

  function runJob(job) {
    return execute(job, {
      renew: () => db.renewWholePaperLease(job),
      payload: () => db.getWholePaperJobPayload(job),
      grade: (payload, signal) => grade({ ...payload, signal }),
      complete: (result) => db.completeWholePaperJob(job, result),
      fail: (message) => db.failWholePaperJob(job, message),
    });
  }

  function runGroupJob(job) {
    return execute(job, {
      renew: () => db.renewPaperGroupLease(job),
      payload: () => db.getPaperGroupJobPayload(job),
      grade: (payload, signal) => gradeGroups({ ...payload, signal }),
      complete: (result) => db.completePaperGroupJob(job, result),
      fail: (message) => db.failPaperGroupJob(job, message),
    });
  }

  function track(promise) {
    const tracked = promise.finally(() => running.delete(tracked));
    running.add(tracked);
    return tracked;
  }

  async function claimRound() {
    const tasks = [];
    let slots = Math.max(0, concurrency - running.size);

    if (slots > 0 && !legacyBusy) {
      // Reserve the legacy slot before the async claim so overlapping ticks
      // cannot claim and run the same whole-paper job twice.
      legacyBusy = true;
      let job;
      try {
        job = await db.claimWholePaperJob();
      } catch (error) {
        legacyBusy = false;
        throw error;
      }
      if (job) {
        slots -= 1;
        tasks.push(track(runJob(job).finally(() => { legacyBusy = false; })));
      } else {
        legacyBusy = false;
      }
    }

    if (slots > 0 && typeof db.claimPaperGroupJobs === "function") {
      const jobs = await db.claimPaperGroupJobs(slots, perStudent);
      for (const job of jobs) tasks.push(track(runGroupJob(job)));
    }

    if (!tasks.length) return false;
    await Promise.allSettled(tasks);
    return true;
  }

  async function runOnce() {
    try {
      await db.recoverWholePaperJobs();
      if (typeof db.recoverPaperGroupJobs === "function") await db.recoverPaperGroupJobs();
      lastHealthyAt = Date.now();
    } catch (error) {
      lastHealthyAt = 0;
      onError(error);
      return false;
    }
    try {
      return await claimRound();
    } catch (error) {
      lastHealthyAt = 0;
      onError(error);
      return false;
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
      for (const controller of controllers) controller.abort();
    },
    isAvailable() {
      return !stopped && lastHealthyAt > 0 && Date.now() - lastHealthyAt < 90000;
    },
  };
}

module.exports = { createWholePaperWorker };
