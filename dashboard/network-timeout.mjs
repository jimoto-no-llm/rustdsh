export async function withNetworkTimeout(timeoutMs, message, work) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
