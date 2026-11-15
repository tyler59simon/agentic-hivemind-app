/** Sends input one call at a time and in order; input typed while a call is in flight is joined into the next call. */
export function makeWriter(send: (data: string) => Promise<unknown>): (data: string) => void {
  let pending = "";
  let busy = false;
  return (data) => {
    pending += data;
    if (busy) return;
    busy = true;
    void (async () => {
      while (pending !== "") {
        const taken = pending;
        pending = "";
        await send(taken).catch(() => {});
      }
      busy = false;
    })();
  };
}
