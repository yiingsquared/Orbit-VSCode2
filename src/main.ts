import {
  providerNames,
  loadChats,
  loadNotes,
  readStored,
  writeStored,
  setStorageAccount,
} from "./store.js";
import type { ProviderId, Chat, Message, Attachment } from "./store.js";
import { streamChat } from "./stream.js";
import { createMemoryLearner, selectSharedMemories } from "./shared-memory.js";
import { renderMarkdown } from "./markdown.js";
import { initAuth } from "./auth.js";
import { initIntro } from "./intro.js";
import { initOnboarding } from "./onboarding.js";
import { initCompanionDemo } from "./demo.js";
import { initWelcomeCat } from "./welcome-cat.js";
import {
  attachUserMessageActions,
  attachAssistantMessageActions,
  refreshMessageActions,
  stopMessageSpeech,
} from "./message-actions.js";
import { initChatSidebar } from "./chat-sidebar.js";
import {
  initCompanion,
  notifyCompanionSelection,
  publishCompanionReply,
  markCompanionReplyRead,
  resetCompanionSession,
} from "./companion.js";
import type { CompanionContext } from "./companion.js";

type Model = { id: string; name: string };
type Catalog = {
  models: Model[];
  defaultModel: string;
  configured: boolean;
  source: string;
  catalogError?: string;
};
type ActiveRequest = { abort: AbortController; chat: Chat; message: Message };

// Page elements

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const result = document.getElementById(id);

  if (!result) throw new Error(`Missing element: ${id}`);

  return result as T;
}

const input = element<HTMLTextAreaElement>("message-input");
const conversation = element("conversation");
const welcome = element("welcome-screen");
const search = element<HTMLInputElement>("chat-search");
const modelButton = element<HTMLButtonElement>("model-picker-button");
const modelMenu = element("model-menu");
const sendButton = element<HTMLButtonElement>("send-button");
const memoryToggle = element<HTMLInputElement>("include-memory");
const chats = loadChats();
const notes = loadNotes();
const catalogs = new Map<ProviderId, Catalog>();
const catalogRequests = new Map<ProviderId, Promise<void>>();
const storedModels = readStored<Partial<Record<ProviderId, string>>>(
  "orbit.models.v1",
  {},
);
const modelSelections =
  storedModels &&
  typeof storedModels === "object" &&
  !Array.isArray(storedModels)
    ? storedModels
    : {};

let provider: ProviderId = "openai";
let currentChat: Chat | null = null;
let activeRequest: ActiveRequest | null = null;
let attachments: Attachment[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let storageWarned = false;
let sidebar: ReturnType<typeof initChatSidebar> | null = null;
let accountId: string | null = null;
let accountGeneration = 0;
let workspaceEnabled = false;
let signingOut = false;
const readReplies = new Set<string>();

memoryToggle.checked = readStored("orbit.includeMemory.v1", true) === true;

// Automatic shared memory

const memoryLearner = createMemoryLearner({
  getNotes: () => notes,
  saveNotes: (next) => {
    if (!writeStored("orbit.notes.v1", next)) return false;

    notes.splice(0, notes.length, ...next);
    writeStored("orbit.preview.notes.v1", notes);
    renderMemory();
    return true;
  },
  getProcessed: () => {
    const saved = readStored<unknown>("orbit.memory.processed.v1", []);

    return Array.isArray(saved)
      ? saved.filter((value): value is string => typeof value === "string")
      : [];
  },
  saveProcessed: (turns) => {
    writeStored("orbit.memory.processed.v1", turns);
  },
  enabled: () => Boolean(accountId) && memoryToggle.checked && !signingOut,
  isCurrent: (turn) =>
    Boolean(
      chats
        .find((chat) => chat.id === turn.chatId)
        ?.messages.some(
          (message) =>
            message.id === turn.messageId &&
            message.text === turn.message &&
            (message.editedAt || 0) === (turn.editedAt || 0),
        ),
    ),
  status: (message, busy) => {
    const status = element("memory-learning-status");

    status.textContent = message;
    status.hidden = !message;
    status.setAttribute("aria-busy", String(busy));
  },
});

// Small UI helpers

function toast(message: string): void {
  const target = element("toast");

  clearTimeout(toastTimer);
  target.textContent = message;
  target.hidden = false;
  toastTimer = setTimeout(() => {
    target.hidden = true;
  }, 4500);
}

function persistChats(): void {
  if (!writeStored("orbit.chats.v1", chats) && !storageWarned) {
    storageWarned = true;
    toast(
      "Browser storage is full. This conversation may not survive a refresh.",
    );
  }
}

function showDialog(id: string): void {
  const dialog = element<HTMLDialogElement>(id);

  if (!dialog.open) dialog.showModal();
}

function selectedModel(): string {
  return (
    currentChat?.model ||
    modelSelections[provider] ||
    catalogs.get(provider)?.defaultModel ||
    ""
  );
}

function resizeInput(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  resizeComposer();
}

function resizeComposer(): void {
  const height = element("message-form").getBoundingClientRect().height;

  element("chat-workspace").style.setProperty(
    "--composer-height",
    `${height + 46}px`,
  );
}

function scrollDown(force = false): void {
  if (
    force ||
    conversation.scrollHeight -
      conversation.scrollTop -
      conversation.clientHeight <
      150
  ) {
    conversation.scrollTop = conversation.scrollHeight;
  }
}

function updateSendButton(): void {
  sendButton.replaceChildren();

  if (activeRequest) {
    const square = document.createElement("span");

    square.className = "stop-square";
    sendButton.append(square, "Stop");
    sendButton.setAttribute("aria-label", "Stop response");
  } else {
    const arrow = document.createElement("span");

    arrow.textContent = "↑";
    sendButton.append(arrow, "Send");
    sendButton.setAttribute("aria-label", "Send message");
  }

  modelButton.disabled = Boolean(activeRequest);

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".message-status button",
  )) {
    button.disabled = Boolean(activeRequest);
  }

  refreshMessageActions();
}

// Provider models

async function loadCatalog(id: ProviderId, refresh = false): Promise<void> {
  if (catalogRequests.has(id)) return catalogRequests.get(id);
  if (catalogs.has(id) && !refresh) return;

  const task = (async () => {
    try {
      const response = await fetch(`/api/models?provider=${id}`);

      if (!response.ok) throw new Error("Could not load available models.");

      const catalog = (await response.json()) as Catalog;

      catalogs.set(id, catalog);

      if (
        !modelSelections[id] ||
        !catalog.models.some((model) => model.id === modelSelections[id])
      ) {
        modelSelections[id] = catalog.defaultModel;
      }

      if (provider === id) renderModels();
    } catch (error) {
      if (provider === id) {
        modelMenu.textContent =
          error instanceof Error ? error.message : "Could not load models.";
      }
    } finally {
      catalogRequests.delete(id);
    }
  })();

  catalogRequests.set(id, task);
  await task;
}

function renderModels(): void {
  const catalog = catalogs.get(provider);
  const selection = selectedModel();
  const selectedName = catalog?.models.find(
    (model) => model.id === selection,
  )?.name;

  element("model-picker-label").textContent =
    selectedName || selection || "Loading models…";
  modelButton.setAttribute(
    "aria-label",
    `Choose model: ${selectedName || selection || providerNames[provider]}`,
  );

  modelMenu.replaceChildren();

  if (!catalog) {
    modelMenu.textContent = "Loading models…";
    return;
  }

  const heading = document.createElement("p");

  heading.className = "model-menu-heading";
  heading.textContent = `${providerNames[provider]} models`;
  modelMenu.append(heading);

  const models = [...catalog.models];

  if (selection && !models.some((model) => model.id === selection))
    models.unshift({ id: selection, name: selection });

  for (const model of models) {
    const button = document.createElement("button");
    const label = document.createElement("span");
    const check = document.createElement("span");

    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(model.id === selection));
    label.textContent = model.name;
    check.textContent = model.id === selection ? "✓" : "";
    button.append(label, check);
    button.addEventListener("click", () => {
      modelSelections[provider] = model.id;
      writeStored("orbit.models.v1", modelSelections);

      if (currentChat) {
        currentChat.model = model.id;
        persistChats();
      }

      renderModels();
      notifyCompanionSelection();
      closeModels();
      modelButton.focus();
    });
    modelMenu.append(button);
  }

  modelButton.title = `Selected: ${selection}`;
}

function closeModels(): void {
  modelMenu.hidden = true;
  modelButton.setAttribute("aria-expanded", "false");
}

function setProvider(id: ProviderId, chat: Chat | null = null): void {
  if (activeRequest) activeRequest.abort.abort();

  stopMessageSpeech();

  provider = id;
  currentChat = chat;
  toggleSidebar(false);
  attachments = [];
  input.value = "";
  element("orbit-app").dataset.provider = id;
  element("provider-title").textContent = providerNames[id];

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".model-button",
  )) {
    const selected = button.dataset.provider === id;

    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }

  closeModels();
  renderModels();
  renderAttachments();
  renderHistory();
  renderConversation();
  resizeInput();
  if (workspaceEnabled) void loadCatalog(id);
  notifyCompanionSelection();
}

// Real conversation history

function renderHistory(): void {
  sidebar?.render();
}

// Reply visibility and unread receipts

function replyIdentity(chat: Chat, message: Message) {
  return {
    chatId: chat.id,
    messageId: message.id,
    revision: message.companionRevision || "",
  };
}

function dismissReplyNotifications(chat: Chat, start = 0): void {
  for (const message of chat.messages.slice(start)) {
    if (message.role !== "assistant" || !message.companionRevision) continue;

    void markCompanionReplyRead(replyIdentity(chat, message)).catch(() => {});
  }
}

function markVisibleReplies(): void {
  if (
    !currentChat ||
    document.visibilityState !== "visible" ||
    !document.hasFocus() ||
    document.querySelector("dialog[open]") ||
    conversation.hidden
  )
    return;

  const view = conversation.getBoundingClientRect();

  for (const message of currentChat.messages) {
    if (
      message.role !== "assistant" ||
      message.state !== "complete" ||
      !message.companionRevision
    )
      continue;

    const key = `${currentChat.id}:${message.id}:${message.companionRevision}`;

    if (readReplies.has(key)) continue;

    const article = conversation.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(message.id)}"]`,
    );
    if (!article) continue;

    const rect = article.getBoundingClientRect();
    const visible =
      Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);

    if (visible < Math.min(12, rect.height)) continue;

    const identity = replyIdentity(currentChat, message);

    readReplies.add(key);
    void markCompanionReplyRead(identity).catch(() => readReplies.delete(key));
  }
}

const replyObserver = new IntersectionObserver(markVisibleReplies, {
  root: conversation,
  threshold: 0,
});

conversation.addEventListener("scroll", markVisibleReplies, { passive: true });
window.addEventListener("focus", () =>
  requestAnimationFrame(markVisibleReplies),
);
document.addEventListener("visibilitychange", () =>
  requestAnimationFrame(markVisibleReplies),
);
document.addEventListener(
  "close",
  () => requestAnimationFrame(markVisibleReplies),
  true,
);

// Message revision actions

async function editMessage(
  chat: Chat,
  message: Message,
  text: string,
): Promise<void> {
  if (activeRequest)
    throw new Error("Wait for the current response to finish.");

  const index = chat.messages.indexOf(message);
  const next = text.trim();

  if (index < 0 || !next || next === message.text) return;

  dismissReplyNotifications(chat, index + 1);
  chat.messages.splice(index + 1);
  message.text = next;
  message.editedAt = Date.now();
  chat.lastSentAt = message.editedAt;
  const assistant: Message = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    state: "pending",
  };

  chat.messages.push(assistant);
  chat.updated = Date.now();
  persistChats();
  renderHistory();
  await sendRequest(chat, assistant);
}

async function regenerateMessage(chat: Chat, message: Message): Promise<void> {
  if (activeRequest)
    throw new Error("Wait for the current response to finish.");

  const index = chat.messages.indexOf(message);

  if (index < 0) return;

  dismissReplyNotifications(chat, index);
  chat.messages.splice(index + 1);
  delete message.feedback;
  await sendRequest(chat, message);
}

function assistantElement(message: Message): HTMLElement {
  const article = document.createElement("article");
  const avatar = document.createElement("img");
  const content = document.createElement("div");
  const body = document.createElement("div");

  article.className = "assistant-message";
  article.dataset.messageId = message.id;
  avatar.src = `/assets/icons/${currentChat?.provider || provider}.svg`;
  avatar.alt = providerNames[currentChat?.provider || provider];
  avatar.className = `assistant-avatar provider-${currentChat?.provider || provider}`;
  content.className = "assistant-content";
  body.className = "assistant-text";
  content.append(body);
  article.append(avatar, content);
  updateAssistant(article, message);
  return article;
}

function updateAssistant(article: HTMLElement, message: Message): void {
  const content = article.querySelector<HTMLElement>(".assistant-content")!;
  const body = article.querySelector<HTMLElement>(".assistant-text")!;
  const nearBottom =
    conversation.scrollHeight -
      conversation.scrollTop -
      conversation.clientHeight <
    160;

  article.classList.toggle("is-streaming", message.state === "pending");
  content.querySelector(".message-status")?.remove();

  if (message.state === "pending") {
    body.textContent = message.text;
    body.classList.add("streaming-text");

    if (!message.text) {
      const dot = document.createElement("span");

      dot.className = "thinking-dot";
      dot.setAttribute("aria-label", "Waiting for reply");
      body.append(dot);
    }
  } else {
    body.classList.remove("streaming-text");
    body.replaceChildren(renderMarkdown(message.text));

    if (message.state === "error" || message.state === "stopped") {
      const status = document.createElement("div");
      const text = document.createElement("p");

      status.className = "message-status";
      text.textContent =
        message.state === "error"
          ? message.error || "The response failed."
          : "Response stopped";
      status.append(text);

      content.append(status);
    }
  }

  const chat = currentChat;

  if (chat) {
    attachAssistantMessageActions(article, message, {
      onRegenerate: () => regenerateMessage(chat, message),
      onFeedback: (value) => {
        if (value) message.feedback = value;
        else delete message.feedback;
        persistChats();
      },
      isBusy: () => Boolean(activeRequest),
      onError: toast,
      fallbackTimestamp: chat.updated,
    });
  }

  if (nearBottom) scrollDown(true);
}

function renderConversation(animateId?: string): void {
  const messages = currentChat?.messages || [];

  welcome.hidden = messages.length > 0;
  conversation.hidden = messages.length === 0;
  replyObserver.disconnect();
  conversation.replaceChildren();

  for (const message of messages) {
    if (message.role === "assistant") {
      const article = assistantElement(message);

      conversation.append(article);
      replyObserver.observe(article);
    } else {
      const row = document.createElement("div");
      const bubble = document.createElement("div");

      row.className = "message-row user-message-row";
      row.dataset.messageId = message.id;

      bubble.className = `message-bubble${message.id === animateId ? " message-enter" : ""}`;
      bubble.textContent = message.text;

      for (const file of message.files || []) {
        const label = document.createElement("small");

        label.className = "message-file";
        label.textContent = file.name;
        bubble.append(label);
      }

      row.append(bubble);
      conversation.append(row);

      const chat = currentChat!;

      attachUserMessageActions(row, message, {
        onEdit: (text) => editMessage(chat, message, text),
        isBusy: () => Boolean(activeRequest),
        onError: toast,
        fallbackTimestamp: chat.updated,
      });
    }
  }

  scrollDown(true);
  requestAnimationFrame(markVisibleReplies);
}

// Real AI requests

async function sendRequest(
  chat: Chat,
  assistant: Message,
  contextOverride?: CompanionContext | null,
): Promise<void> {
  if (activeRequest) return;

  const abort = new AbortController();
  const request: ActiveRequest = { abort, chat, message: assistant };
  const requestGeneration = accountGeneration;
  const index = chat.messages.indexOf(assistant);
  const preceding = chat.messages.slice(0, index);
  const history = preceding
    .filter(
      (message) =>
        message.role === "user" ||
        (message.state === "complete" && message.text),
    )
    .slice(-59);

  while (history[0]?.role === "assistant") history.shift();

  activeRequest = request;
  assistant.text = "";
  assistant.error = undefined;
  assistant.model = chat.model;
  assistant.state = "pending";
  assistant.companionRevision = crypto.randomUUID();
  updateSendButton();
  renderConversation(preceding.at(-1)?.id);

  const article = conversation.querySelector<HTMLElement>(
    `[data-message-id="${assistant.id}"]`,
  )!;

  try {
    await memoryLearner.ready(abort.signal);
    if (requestGeneration !== accountGeneration) return;

    const referenceFiles: Attachment[] = preceding
      .flatMap((message) => message.files || [])
      .slice(-3);
    const live =
      contextOverride === undefined
        ? ((await fetch("/api/companion/current-context")
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null)) as { context?: CompanionContext | null } | null)
        : { context: contextOverride };

    if (live?.context?.text) {
      const context = live.context;

      referenceFiles.push({
        name: (context.title || context.windowTitle || "Current window").slice(
          0,
          180,
        ),
        text: `Captured ${context.capturedAt}\n${context.url || context.app}\n\n${context.text}`.slice(
          0,
          30000,
        ),
      });
    }

    abort.signal.throwIfAborted();

    await streamChat(
      {
        provider: chat.provider,
        model: chat.model,
        messages: history.map((message) => ({
          role: message.role,
          text: message.text,
        })),
        memories: memoryToggle.checked
          ? selectSharedMemories(notes).map((note) => note.text)
          : [],
        attachments: referenceFiles.slice(-3),
      },
      abort.signal,
      (event) => {
        if (
          requestGeneration === accountGeneration &&
          event.type === "delta" &&
          event.text
        ) {
          assistant.text += event.text;

          if (currentChat === chat) updateAssistant(article, assistant);
        }
      },
    );

    abort.signal.throwIfAborted();
    if (requestGeneration !== accountGeneration) return;

    assistant.state = "complete";
    assistant.createdAt = Date.now();

    const sentUser = preceding.at(-1);

    if (sentUser?.role === "user")
      void memoryLearner.learn({
        provider: chat.provider,
        model: chat.model,
        chatId: chat.id,
        messageId: sentUser.id,
        message: sentUser.text,
        editedAt: sentUser.editedAt,
      });

    void publishCompanionReply({
      ...replyIdentity(chat, assistant),
      text: assistant.text,
    }).catch(() => {});
  } catch (error) {
    assistant.state = abort.signal.aborted ? "stopped" : "error";
    assistant.error = abort.signal.aborted
      ? undefined
      : error instanceof Error
        ? error.message
        : "Unable to connect to the provider.";
  } finally {
    chat.updated = Date.now();
    if (requestGeneration === accountGeneration) persistChats();

    if (activeRequest === request) activeRequest = null;

    updateSendButton();

    if (currentChat === chat) {
      updateAssistant(article, assistant);
      renderHistory();
      requestAnimationFrame(markVisibleReplies);
    }
  }
}

async function submitMessage(
  text: string,
  context?: CompanionContext | null,
): Promise<Message | undefined> {
  if (!workspaceEnabled || signingOut) return;
  if (activeRequest)
    throw new Error("Orbit is finishing the previous response.");

  if (!text) return;
  if (!selectedModel()) {
    toast("Models are still loading. Please try again.");
    void loadCatalog(provider, true);
    return;
  }

  if (!currentChat) {
    currentChat = {
      id: crypto.randomUUID(),
      provider,
      model: selectedModel(),
      title: text.replace(/\s+/g, " ").slice(0, 70),
      updated: Date.now(),
      messages: [],
    };
    chats.push(currentChat);
  }

  const user: Message = {
    id: crypto.randomUUID(),
    role: "user",
    text,
    state: "complete",
    files: attachments,
    createdAt: Date.now(),
  };
  const assistant: Message = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    state: "pending",
  };

  currentChat.messages.push(user, assistant);
  currentChat.updated = Date.now();
  currentChat.lastSentAt = currentChat.updated;
  attachments = [];
  input.value = "";
  resizeInput();
  renderAttachments();
  persistChats();
  renderHistory();
  await sendRequest(currentChat, assistant, context);
  return assistant;
}

element<HTMLFormElement>("message-form").addEventListener("submit", (event) => {
  event.preventDefault();

  if (activeRequest) {
    activeRequest.abort.abort();
    return;
  }

  void submitMessage(input.value.trim()).catch((error) => toast(error.message));
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();

    if (!activeRequest)
      element<HTMLFormElement>("message-form").requestSubmit();
  }
});

// Saved memory

function renderMemory(): void {
  const target = element("memory-items");

  target.replaceChildren();
  updateMemoryBadge();
  sidebar?.renderArchiveMemory();

  for (const count of document.querySelectorAll(".memory-count-text"))
    count.textContent = String(notes.length);

  if (!notes.length) {
    const empty = document.createElement("p");

    empty.className = "memory-empty";
    empty.textContent =
      "Important details from your chats will appear here. You can also add a memory below.";
    target.append(empty);
  }

  for (const note of [...notes].sort(
    (a, b) => (b.updated || b.created) - (a.updated || a.created),
  )) {
    const row = document.createElement("div");
    const content = document.createElement("div");
    const text = document.createElement("p");
    const meta = document.createElement("div");
    const origin = document.createElement("span");
    const remove = document.createElement("button");

    row.className = "memory-entry";
    content.className = "memory-entry-content";
    text.textContent = note.text;
    meta.className = "memory-source";
    origin.textContent = note.source ? "Auto-saved" : "Added manually";

    if (note.source) {
      const logo = document.createElement("img");
      const name = providerNames[note.source.provider];

      logo.className = "memory-source-icon";
      logo.src = `/assets/icons/${note.source.provider}.svg`;
      logo.alt = name;
      logo.title = `From your ${name} conversation`;
      meta.title = logo.title;
      meta.append(logo);
    }

    meta.append(origin);
    remove.innerHTML = '<svg aria-hidden="true"><use href="#i-trash" /></svg>';
    remove.type = "button";
    remove.setAttribute("aria-label", "Delete memory");
    remove.title = "Delete memory";
    remove.addEventListener("click", () => {
      const next = notes.filter((entry) => entry.id !== note.id);

      if (!writeStored("orbit.notes.v1", next)) {
        toast("This memory could not be deleted. Please try again.");
        return;
      }

      memoryLearner.forget(note);
      notes.splice(0, notes.length, ...next);
      writeStored("orbit.preview.notes.v1", next);
      renderMemory();
    });
    content.append(text, meta);
    row.append(content, remove);
    target.append(row);
  }
}

element<HTMLFormElement>("memory-form").addEventListener("submit", (event) => {
  event.preventDefault();

  const field = element<HTMLTextAreaElement>("memory-note");
  const text = field.value.trim();

  if (!text) return;
  if (notes.length >= 100) {
    toast("You have 100 memories. Delete a note before adding another.");
    return;
  }

  const next = [
    ...notes,
    { id: crypto.randomUUID(), text, created: Date.now() },
  ];

  if (!writeStored("orbit.notes.v1", next)) {
    toast("Browser storage is full. This memory could not be saved.");
    return;
  }

  notes.splice(0, notes.length, ...next);
  writeStored("orbit.preview.notes.v1", next);

  field.value = "";
  renderMemory();
});

memoryToggle.addEventListener("change", () => {
  writeStored("orbit.includeMemory.v1", memoryToggle.checked);

  if (!memoryToggle.checked) memoryLearner.reset();
});

// Connection status

function updateMemoryBadge(): void {
  element("memory-count").textContent = String(notes.length);
}

// Released assistants

function renderProviderAvailability(): void {
  const available = element("available-providers");
  const upcoming = element("upcoming-providers");

  available.replaceChildren();
  upcoming.replaceChildren();

  for (const id of Object.keys(providerNames) as ProviderId[]) {
    const released = id === "openai";
    const row = document.createElement(released ? "button" : "div");
    const icon = document.createElement("img");
    const details = document.createElement("span");
    const name = document.createElement("strong");
    const status = document.createElement("span");

    row.className = `provider-connection${released ? " is-available" : ""}${["openai", "grok", "perplexity"].includes(id) ? " is-monochrome" : ""}`;
    row.dataset.provider = id;
    icon.src = `/assets/icons/${id}.svg`;
    icon.alt = "";
    details.className = "availability-details";
    name.textContent = released ? "OpenAI" : providerNames[id];
    status.className = "availability-status";
    status.textContent = released ? "Available" : "Coming soon";
    details.append(name);

    if (released) {
      const subtitle = document.createElement("small");

      subtitle.textContent = "ChatGPT";
      details.append(subtitle);
      row.setAttribute("type", "button");
      row.setAttribute("aria-label", "Open ChatGPT");
      row.addEventListener("click", () => {
        element<HTMLDialogElement>("settings-dialog").close();
        setProvider("openai");
      });
    }

    row.append(icon, details, status);
    (released ? available : upcoming).append(row);
  }
}

// Text attachments

function renderAttachments(): void {
  const target = element("attachment-list");

  target.replaceChildren();
  target.hidden = attachments.length === 0;

  attachments.forEach((file, index) => {
    const chip = document.createElement("span");
    const name = document.createElement("span");
    const remove = document.createElement("button");

    chip.className = "attachment-chip";
    name.textContent = file.name;
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => {
      attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(name, remove);
    target.append(chip);
  });

  resizeComposer();
}

element("attach-button").addEventListener("click", () =>
  element<HTMLInputElement>("attachment-input").click(),
);
element<HTMLInputElement>("attachment-input").addEventListener(
  "change",
  async (event) => {
    const field = event.target as HTMLInputElement;
    const generation = accountGeneration;

    for (const file of Array.from(field.files || [])) {
      if (attachments.length >= 3) {
        toast("Attach up to 3 text files per message.");
        break;
      }
      if (
        !/\.(txt|md|csv|json|html|css|js|ts|py|xml|ya?ml|log)$/i.test(
          file.name,
        ) ||
        file.size > 30000
      ) {
        toast("Choose a text or code file smaller than 30 KB.");
        continue;
      }

      try {
        const text = await file.text();

        if (generation !== accountGeneration || !workspaceEnabled) break;

        attachments.push({
          name: file.name.slice(0, 180),
          text,
        });
      } catch {
        if (generation === accountGeneration)
          toast(`Could not read ${file.name}.`);
      }
    }

    field.value = "";
    renderAttachments();
  },
);

// Navigation and dialogs

function toggleSidebar(open: boolean): void {
  element("orbit-app").classList.toggle("sidebar-is-open", open);
  element("sidebar-backdrop").hidden = !open;
  element("sidebar-toggle").setAttribute("aria-expanded", String(open));
}

element("sidebar-toggle").addEventListener("click", () => {
  toggleSidebar(!element("orbit-app").classList.contains("sidebar-is-open"));
});
element("sidebar-backdrop").addEventListener("click", () =>
  toggleSidebar(false),
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleSidebar(false);
});

for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".model-button",
)) {
  button.addEventListener("click", () =>
    setProvider(button.dataset.provider as ProviderId),
  );
}

for (const button of document.querySelectorAll("[data-new-chat]"))
  button.addEventListener("click", () => {
    setProvider(provider);
    input.focus();
  });

element("orbit-home").addEventListener("click", () => setProvider(provider));
element("search-toggle").addEventListener("click", () => {
  const box = element("search-box");

  box.hidden = !box.hidden;

  if (!box.hidden) search.focus();
  else {
    sidebar?.clearSearch();
  }
});

for (const button of document.querySelectorAll<HTMLElement>("[data-prompt]")) {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt || "";
    resizeInput();
    input.focus();
  });
}

element("view-tasks").addEventListener("click", () => {
  input.value = "Help me choose a useful task to get started.";
  input.focus();
});

modelButton.addEventListener("click", async () => {
  const opening = modelMenu.hidden;

  modelMenu.hidden = !opening;
  modelButton.setAttribute("aria-expanded", String(opening));

  if (opening) {
    await loadCatalog(provider);
    modelMenu
      .querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
  }
});

document.addEventListener("click", (event) => {
  if (!(event.target as Element).closest(".model-control")) closeModels();
});

modelMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModels();
    modelButton.focus();
  }

  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();

    const buttons = Array.from(modelMenu.querySelectorAll("button"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;

    buttons[next]?.focus();
  }
});

for (const button of document.querySelectorAll("[data-open-settings]"))
  button.addEventListener("click", () => {
    showDialog("settings-dialog");
  });
for (const button of document.querySelectorAll("[data-open-memory]"))
  button.addEventListener("click", () => {
    renderMemory();
    showDialog("memory-dialog");
  });

for (const button of document.querySelectorAll("[data-open-companion]"))
  button.addEventListener("click", () => onboarding.openCompanion());
for (const button of document.querySelectorAll("[data-close-dialog]"))
  button.addEventListener("click", () => button.closest("dialog")?.close());

// Conversation export

async function shareChat(chat: Chat | null): Promise<void> {
  if (!chat?.messages.length) {
    toast("Send a message to start a conversation first.");
    return;
  }

  const text = `# ${chat.title}\n\n${chat.messages
    .filter((message) => message.text)
    .map(
      (message) =>
        `## ${message.role === "user" ? "You" : providerNames[chat.provider]}\n\n${message.text}`,
    )
    .join("\n\n")}`;

  try {
    await navigator.clipboard.writeText(text);
    toast("Conversation copied. Paste it to share.");
  } catch {
    toast(
      "Clipboard access is unavailable. Select and copy the conversation instead.",
    );
  }
}

element("share-button").addEventListener("click", () => {
  void shareChat(currentChat);
});

// Optional browser dictation

type SpeechSession = {
  lang: string;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: {
          [index: number]: { [index: number]: { transcript: string } };
        };
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const speechWindow = window as unknown as {
  SpeechRecognition?: new () => SpeechSession;
  webkitSpeechRecognition?: new () => SpeechSession;
};

let speech: SpeechSession | null = null;

element("voice-button").addEventListener("click", () => {
  if (speech) {
    speech.stop();
    return;
  }

  const Recognition =
    speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;

  if (!Recognition) {
    toast("Voice input is unavailable in this browser. Try Chrome.");
    return;
  }

  const session = new Recognition();
  const generation = accountGeneration;

  speech = session;
  session.lang = navigator.language || "en-US";
  session.interimResults = false;
  session.onresult = (event) => {
    if (
      speech !== session ||
      generation !== accountGeneration ||
      !workspaceEnabled
    )
      return;

    input.value = `${input.value} ${event.results[0][0].transcript}`
      .trim()
      .slice(0, 30000);
    resizeInput();
    input.focus();
  };
  session.onerror = () => {
    if (speech === session && generation === accountGeneration)
      toast(
        "Voice input could not start. Check your browser microphone permission.",
      );
  };
  session.onend = () => {
    if (speech !== session) return;

    speech = null;
    element("voice-button").classList.remove("is-listening");
  };
  element("voice-button").classList.add("is-listening");

  try {
    session.start();
  } catch {
    speech = null;
    toast("Voice input could not start.");
  }
});

// Initial state

sidebar = initChatSidebar({
  getChats: () => chats,
  getProvider: () => provider,
  getCurrentChatId: () => currentChat?.id || null,
  onOpen: (id) => {
    const chat = chats.find((item) => item.id === id);

    if (!chat) return;

    setProvider(chat.provider, chat);
  },
  onChange: () => {
    persistChats();
  },
  onDelete: (id) => {
    const index = chats.findIndex((chat) => chat.id === id);

    if (index < 0) return;

    const chat = chats[index];
    dismissReplyNotifications(chat);
    if (activeRequest?.chat.id === id) activeRequest.abort.abort();
    chats.splice(index, 1);
    persistChats();
    if (currentChat?.id === id) setProvider(provider);
    else renderHistory();
  },
  onShare: (id) => shareChat(chats.find((chat) => chat.id === id) || null),
  onError: toast,
});
initCompanionDemo();
initWelcomeCat();
renderMemory();
setProvider("openai");
updateSendButton();
new ResizeObserver(resizeComposer).observe(element("message-form"));
renderProviderAvailability();

// Signed-in workspace lifecycle

const onboarding = initOnboarding({
  getAuth: () => auth,
  onStageChange: (stage) => {
    workspaceEnabled = stage === "workspace";
    notifyCompanionSelection();

    if (workspaceEnabled) {
      setProvider(provider, currentChat);
      renderMemory();
      requestAnimationFrame(resizeComposer);
    }
  },
  onInstalled: () =>
    toast(
      "Download started. Run Orbit-Setup.exe to bring your companion to life.",
    ),
});

initIntro({ onGetStarted: () => void onboarding.getStarted() });

const auth = initAuth({
  showAccountAfterOAuth: false,
  onChange: (user, meta) => {
    signingOut = false;

    if (accountId !== (user?.id || null)) {
      accountGeneration += 1;
      memoryLearner.reset();
      activeRequest?.abort.abort();
      activeRequest = null;
      stopMessageSpeech();
      speech?.stop();
      readReplies.clear();
      accountId = user?.id || null;
      setStorageAccount(accountId, !meta.isNewAccount);
      chats.splice(0, chats.length, ...loadChats());
      notes.splice(0, notes.length, ...loadNotes());
      memoryToggle.checked =
        readStored("orbit.includeMemory.v1", true) === true;
      currentChat = null;
      resetCompanionSession();
      renderMemory();
      setProvider("openai");
    }

    onboarding.authChanged(user, meta);
    if (meta.source === "logout") auth.close();
  },
  beforeSignOut: async () => {
    accountGeneration += 1;
    memoryLearner.reset();
    signingOut = true;
    workspaceEnabled = false;

    if (activeRequest) {
      activeRequest.abort.abort();
      activeRequest.message.state = "stopped";
      persistChats();
    }

    stopMessageSpeech();
    speech?.stop();
    resetCompanionSession();

    try {
      const response = await fetch("/api/companion/quit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signOut: true }),
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok)
        throw new Error(
          "Could not quit your companion. Try signing out again.",
        );
    } catch (error) {
      signingOut = false;
      workspaceEnabled = onboarding.getStage() === "workspace";
      notifyCompanionSelection();
      throw error;
    }
  },
});

window.addEventListener("orbit:authsignouterror", () => {
  signingOut = false;
  workspaceEnabled = onboarding.getStage() === "workspace";
  notifyCompanionSelection();
});

initCompanion({
  enabled: () => workspaceEnabled && !signingOut,
  getSelection: () => ({ provider, model: selectedModel() }),
  isBusy: () => Boolean(activeRequest),
  onMessage: async (message) => {
    const reply = await submitMessage(message.text, message.context || null);

    return reply
      ? { text: reply.text, error: reply.error }
      : { text: "", error: "Choose a model in Orbit and try again." };
  },
});
