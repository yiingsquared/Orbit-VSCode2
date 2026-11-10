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

export type Note = { id: string; text: string; created: number };

export const providerNames: Record<ProviderId, string> = {
  openai: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  deepseek: "DeepSeek",
  grok: "Grok",
  perplexity: "Perplexity",
};

// Browser persistence

export function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);

    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
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
      created: Number.isFinite(Number(note.created))
        ? Number(note.created)
        : Date.parse(String(note.created)) || Date.now(),
    }));
}
