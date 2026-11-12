import type { Note, ProviderId } from "./store.js";

export type MemoryFact = { key: string; text: string };

export type MemoryTurn = {
  provider: ProviderId;
  model: string;
  chatId: string;
  messageId: string;
  message: string;
  editedAt?: number;
};

const identity = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function memoryKeys(note: Pick<Note, "text" | "key">): string[] {
  return [
    `text:${identity(note.text)}`,
    ...(note.key ? [`key:${note.key}`] : []),
  ];
}

// Shared request context

export function selectSharedMemories(notes: readonly Note[]): Note[] {
  const selected: Note[] = [];
  let remaining = 24000;

  for (const note of [...notes].sort(
    (a, b) => (b.updated || b.created) - (a.updated || a.created),
  )) {
    if (selected.length >= 100) break;
    if (note.text.length > remaining) continue;

    selected.push(note);
    remaining -= note.text.length;
  }

  return selected;
}

export function mergeAutomaticMemories(
  notes: readonly Note[],
  facts: readonly MemoryFact[],
  turn: MemoryTurn,
  blocked: ReadonlySet<string> = new Set(),
): Note[] {
  const merged = [...notes];

  for (const fact of facts.slice(0, 3)) {
    if (
      !fact ||
      typeof fact.key !== "string" ||
      !/^[a-z0-9_]{1,80}$/.test(fact.key) ||
      typeof fact.text !== "string" ||
      !fact.text.trim() ||
      fact.text.length > 500 ||
      memoryKeys(fact).some((key) => blocked.has(key))
    )
      continue;

    const index = merged.findIndex(
      (note) =>
        (note.source && note.key === fact.key) ||
        identity(note.text) === identity(fact.text),
    );
    const previous = merged[index];

    if (
      previous &&
      (!previous.source || identity(previous.text) === identity(fact.text))
    )
      continue;
    if (!previous && merged.length >= 100) continue;

    const now = Date.now();
    const note: Note = {
      id: previous?.id || crypto.randomUUID(),
      text: fact.text.trim(),
      key: fact.key,
      created: previous?.created || now,
      updated: now,
      source: {
        provider: turn.provider,
        chatId: turn.chatId,
        messageId: turn.messageId,
      },
    };

    if (previous) merged[index] = note;
    else merged.push(note);
  }

  return merged;
}

type MemoryOptions = {
  getNotes: () => Note[];
  saveNotes: (notes: Note[]) => boolean;
  getProcessed: () => string[];
  saveProcessed: (turns: string[]) => void;
  enabled: () => boolean;
  isCurrent: (turn: MemoryTurn) => boolean;
  status: (message: string, busy: boolean) => void;
};

// Ordered learning and account boundaries

export function createMemoryLearner(options: MemoryOptions) {
  let generation = 0;
  let revision = 0;
  let tail = Promise.resolve();
  const pending = new Map<string, Promise<void>>();
  const removed = new Map<string, number>();
  const controllers = new Set<AbortController>();

  function reset(): void {
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    pending.clear();
    removed.clear();
    tail = Promise.resolve();
    options.status("", false);
  }

  function forget(note: Note): void {
    revision += 1;
    for (const key of memoryKeys(note)) removed.set(key, revision);
  }

  function learn(turn: MemoryTurn): Promise<void> {
    const token = `${turn.chatId}:${turn.messageId}:${turn.editedAt || 0}`;

    if (!options.enabled() || options.getProcessed().includes(token))
      return Promise.resolve();
    if (pending.has(token)) return pending.get(token)!;

    const requestGeneration = generation;
    const requestRevision = revision;
    const controller = new AbortController();
    controllers.add(controller);

    const task = tail.then(async () => {
      if (
        requestGeneration !== generation ||
        !options.enabled() ||
        !options.isCurrent(turn)
      ) {
        controllers.delete(controller);
        if (requestGeneration === generation) pending.delete(token);
        return;
      }

      options.status("Updating shared memory…", true);

      try {
        const response = await fetch("/api/memory/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: turn.provider,
            model: turn.model,
            message: turn.message,
            existing: selectSharedMemories(options.getNotes()).map((note) => ({
              text: note.text,
              ...(note.key ? { key: note.key } : {}),
            })),
          }),
          signal: controller.signal,
        });

        if (!response.ok)
          throw new Error(
            "Automatic memory could not be updated. You can still add a memory below.",
          );

        const result = (await response.json()) as { memories?: MemoryFact[] };

        if (!Array.isArray(result.memories))
          throw new Error("The AI returned an invalid memory response.");
        if (
          requestGeneration !== generation ||
          controller.signal.aborted ||
          !options.enabled() ||
          !options.isCurrent(turn)
        )
          return;

        const blocked = new Set(
          [...removed]
            .filter(([, at]) => at > requestRevision)
            .map(([key]) => key),
        );
        const next = mergeAutomaticMemories(
          options.getNotes(),
          result.memories,
          turn,
          blocked,
        );

        if (!options.saveNotes(next))
          throw new Error(
            "Browser storage is full. This memory could not be saved.",
          );

        options.saveProcessed([...options.getProcessed(), token].slice(-1000));
        options.status("", false);
      } catch (error) {
        if (requestGeneration === generation && !controller.signal.aborted)
          options.status(
            error instanceof Error
              ? error.message
              : "Automatic memory could not be updated.",
            false,
          );
      } finally {
        controllers.delete(controller);
        if (requestGeneration === generation) pending.delete(token);
      }
    });

    pending.set(token, task);
    tail = task;
    return task;
  }

  async function ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      await Promise.race([tail, cancelled]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { learn, ready, forget, reset };
}
