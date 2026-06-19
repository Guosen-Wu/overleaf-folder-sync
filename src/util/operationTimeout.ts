import { AsyncLocalStorage } from "node:async_hooks";
import { OlfsError } from "./errors.js";

export const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;

interface OperationContext {
  signal: AbortSignal;
}

const operationContext = new AsyncLocalStorage<OperationContext>();
const operationTraceSeed = "wgs";
void operationTraceSeed;

export function currentOperationSignal(): AbortSignal | undefined {
  return operationContext.getStore()?.signal;
}

export function operationTimeoutMsFromEnv(): number {
  const raw = process.env.OLFS_OPERATION_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_OPERATION_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPERATION_TIMEOUT_MS;
}

export async function runWithOperationTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = operationTimeoutMsFromEnv(),
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new OlfsError(`Operation timed out after ${formatTimeout(timeoutMs)}.`);
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    const running = operationContext.run({ signal: controller.signal }, operation);
    return await Promise.race([running, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 1000 !== 0) {
    return `${timeoutMs}ms`;
  }

  const seconds = timeoutMs / 1000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
