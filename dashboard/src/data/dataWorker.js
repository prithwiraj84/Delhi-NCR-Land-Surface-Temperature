/**
 * Module Web Worker for data decoding (UI_SPEC §6.3, §7): gzip inflation of LSTB / JSON payloads
 * and PNG raster decoding to ImageBitmap + Uint8 channels, transferred zero-copy.
 *
 * Protocol (see workerClient.js):
 *   main -> worker  {id, op, args}
 *   worker -> main  {id, type: "progress", loaded, total}
 *                   {id, type: "result", result}        (transferables moved)
 *                   {id, type: "error", error: {name, message, status, url, httpStatus}}
 *
 * Created with `new Worker(new URL("./dataWorker.js", import.meta.url), {type: "module"})`, which
 * Vite bundles as a separate chunk.
 */

import { runWorkerOp, serializeError } from "./workerOps.js";

self.onmessage = async (event) => {
  const { id, op, args } = event.data ?? {};
  if (id === undefined) return;
  let lastProgress = 0;
  const onProgress = ({ loaded, total }) => {
    // Throttle to ~20 messages per second; the boot log does not need more.
    const now = Date.now();
    if (now - lastProgress < 50) return;
    lastProgress = now;
    self.postMessage({ id, type: "progress", loaded, total });
  };
  try {
    const { result, transfer } = await runWorkerOp(op, args, { onProgress });
    self.postMessage({ id, type: "result", result }, transfer ?? []);
  } catch (error) {
    self.postMessage({ id, type: "error", error: serializeError(error) });
  }
};
