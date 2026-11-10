export type ChatEvent = {
  type: "start" | "delta" | "done" | "error";
  text?: string;
  message?: string;
};

// Streaming fetch

export async function streamChat(
  payload: unknown,
  signal: AbortSignal,
  receive: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));

    throw new Error(detail.message || `Connection failed (${response.status})`);
  }

  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    throw new Error("The local server did not return a response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;

  function handleFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data) return;

    const event = JSON.parse(data) as ChatEvent;

    if (event.type === "error")
      throw new Error(event.message || "The response failed.");
    if (event.type === "done") completed = true;

    receive(event);
  }

  try {
    while (true) {
      const { value, done } = await reader.read();

      pending = (pending + decoder.decode(value, { stream: !done })).replace(
        /\r\n/g,
        "\n",
      );

      let split;

      while ((split = pending.indexOf("\n\n")) !== -1) {
        handleFrame(pending.slice(0, split));
        pending = pending.slice(split + 2);
      }

      if (done) break;
    }

    if (pending.trim()) handleFrame(pending);
    if (!completed)
      throw new Error(
        "The connection ended before the reply was complete. Retry this message.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
