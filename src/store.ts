export type ProviderId =
  | "openai"
  | "gemini"
  | "claude"
  | "deepseek"
  | "grok"
  | "perplexity";

export type Attachment = { name: string; text: string };

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  state: "complete" | "pending" | "error" | "stopped";
  error?: string;
  model?: string;
  files?: Attachment[];
  createdAt?: number;
  editedAt?: number;
  feedback?: "up" | "down";
  companionRevision?: string;
};

export type Chat = {
  id: string;
  provider: ProviderId;
  model: string;
  title: string;
  updated: number;
  lastSentAt?: number;
  messages: Message[];
  saved?: boolean;
  archived?: boolean;
};

export type Note = {
  id: string;
  text: string;
  created: number;
  updated?: number;
  key?: string;
  source?: { provider: ProviderId; chatId: string; messageId: string };
};

export const providerNames: Record<ProviderId, string> = {
  openai: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  deepseek: "DeepSeek",
  grok: "Grok",
  perplexity: "Perplexity",
};

// Browser persistence

const accountKeys = new Set([
  "orbit.chats.v1",
  "orbit.notes.v1",
  "orbit.preview.notes.v1",
  "orbit.includeMemory.v1",
  "orbit.memory.processed.v1",
]);
const legacyOwnerKey = "orbit.storage.legacy-owner.v1";
const memoryClaims = new WeakMap<Storage, string>();
const memorySkips = new WeakMap<Storage, Set<string>>();
let storageAccount: string | null = null;

type LegacyOwner = { accountId: string; copied: string[] };

function accountKey(key: string): string | null {
  if (!accountKeys.has(key)) return key;

  return storageAccount
    ? `orbit.account.v1:${encodeURIComponent(storageAccount)}:${key}`
    : null;
}

function mergeLegacyRows(current: unknown[], legacy: unknown[]): unknown[] {
  const rowKey = (row: unknown): string =>
    row && typeof row === "object" && "id" in row && typeof row.id === "string"
      ? `id:${row.id}`
      : `json:${JSON.stringify(row)}`;
  const seen = new Set(current.map(rowKey));
  const imported: unknown[] = [];

  for (const row of legacy) {
    const key = rowKey(row);

    if (seen.has(key)) continue;

    seen.add(key);
    imported.push(row);
  }

  return [...imported, ...current];
}

// One-time legacy ownership

function importLegacy(storage: Storage, accountId: string): void {
  const rawOwner = storage.getItem(legacyOwnerKey);
  let owner: LegacyOwner;

  if (rawOwner === null) {
    const claimed = memoryClaims.get(storage);

    if (claimed && claimed !== accountId) return;

    memoryClaims.set(storage, accountId);
    owner = { accountId, copied: [] };
    storage.setItem(legacyOwnerKey, JSON.stringify(owner));
  } else {
    const candidate = JSON.parse(rawOwner) as Partial<LegacyOwner> | null;

    if (
      !candidate ||
      typeof candidate.accountId !== "string" ||
      !Array.isArray(candidate.copied)
    )
      return;

    owner = {
      accountId: candidate.accountId,
      copied: candidate.copied.filter(
        (key): key is string => typeof key === "string",
      ),
    };
  }

  if (owner.accountId !== accountId) return;

  const confirmed = JSON.parse(
    storage.getItem(legacyOwnerKey) || "null",
  ) as LegacyOwner | null;

  if (confirmed?.accountId !== accountId) return;

  for (const key of accountKeys) {
    if (owner.copied.includes(key)) continue;

    try {
      const legacy = storage.getItem(key);
      const destination = accountKey(key)!;
      const current = storage.getItem(destination);

      if (legacy !== null && current === null)
        storage.setItem(destination, legacy);
      else if (
        legacy !== null &&
        current !== null &&
        key !== "orbit.includeMemory.v1"
      ) {
        const oldRows = JSON.parse(legacy) as unknown;
        const currentRows = JSON.parse(current) as unknown;

        if (Array.isArray(oldRows) && Array.isArray(currentRows)) {
          storage.setItem(
            destination,
            JSON.stringify(mergeLegacyRows(currentRows, oldRows)),
          );
        }
      }

      owner.copied.push(key);
      storage.setItem(legacyOwnerKey, JSON.stringify(owner));
    } catch {
      // Original data remains available for another import attempt
    }
  }
}

export function setStorageAccount(
  userId: string | null,
  shouldImportLegacy = true,
): void {
  storageAccount =
    typeof userId === "string" &&
    userId.length > 0 &&
    userId.length <= 256 &&
    !/[\u0000-\u001f]/.test(userId)
      ? userId
      : null;

  if (!storageAccount) return;

  try {
    encodeURIComponent(storageAccount);
  } catch {
    storageAccount = null;
    return;
  }

  try {
    const storage = localStorage;
    const skipKey = `orbit.account.v1:${encodeURIComponent(storageAccount)}:orbit.legacy-import-skipped.v1`;

    if (!shouldImportLegacy) {
      const skipped = memorySkips.get(storage) || new Set<string>();

      skipped.add(storageAccount);
      memorySkips.set(storage, skipped);
      storage.setItem(skipKey, "true");
      return;
    }

    if (
      memorySkips.get(storage)?.has(storageAccount) ||
      storage.getItem(skipKey) === "true"
    )
      return;

    importLegacy(storage, storageAccount);
  } catch {
    // Keep legacy data untouched when storage is unavailable
  }
}

export function readStored<T>(key: string, fallback: T): T {
  const destination = accountKey(key);

  if (!destination) return fallback;

  try {
    const value = localStorage.getItem(destination);

    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): boolean {
  const destination = accountKey(key);

  if (!destination) return false;

  try {
    localStorage.setItem(destination, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadChats(): Chat[] {
  const raw = readStored<unknown>("orbit.chats.v1", []);

  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (chat): chat is Chat =>
        chat &&
        typeof chat.id === "string" &&
        Object.hasOwn(providerNames, chat.provider) &&
        typeof chat.model === "string" &&
        typeof chat.title === "string" &&
        Number.isFinite(chat.updated) &&
        Array.isArray(chat.messages) &&
        chat.messages.every(
          (message: Message) =>
            message &&
            ["user", "assistant"].includes(message.role) &&
            typeof message.text === "string" &&
            typeof message.id === "string",
        ),
    )
    .map((chat) => ({
      ...chat,
      messages: chat.messages.map((message) => ({
        ...message,
        state: message.state === "pending" ? "stopped" : message.state,
      })),
    }));
}

export function loadNotes(): Note[] {
  const raw = readStored<unknown>(
    "orbit.notes.v1",
    readStored<unknown>("orbit.preview.notes.v1", []),
  );

  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (note): note is Note =>
        note &&
        typeof note.id === "string" &&
        typeof note.text === "string" &&
        note.text.length <= 2000 &&
        (Number.isFinite(note.created) || typeof note.created === "string"),
    )
    .map((note) => ({
      ...note,
      key:
        typeof note.key === "string" && /^[a-z0-9_]{1,80}$/.test(note.key)
          ? note.key
          : undefined,
      source:
        note.source &&
        Object.hasOwn(providerNames, note.source.provider) &&
        typeof note.source.chatId === "string" &&
        typeof note.source.messageId === "string"
          ? note.source
          : undefined,
      created: Number.isFinite(Number(note.created))
        ? Number(note.created)
        : Date.parse(String(note.created)) || Date.now(),
    }));
}
