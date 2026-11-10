export type MessageFeedback = "up" | "down" | undefined;

export type ActionMessage = {
  id: string;
  text: string;
  state?: "complete" | "pending" | "error" | "stopped";
  createdAt?: number;
  editedAt?: number;
  feedback?: MessageFeedback;
  files?: { name: string }[];
};

type CommonOptions = {
  isBusy: () => boolean;
  onError?: (message: string) => void;
  fallbackTimestamp?: number;
};

type UserOptions = CommonOptions & {
  onEdit: (text: string) => void | Promise<void>;
};
type AssistantOptions = CommonOptions & {
  onRegenerate: () => void | Promise<void>;
  onFeedback: (feedback: MessageFeedback) => void | Promise<void>;
};

type ActionController = {
  message: ActionMessage;
  options: CommonOptions;
  refresh: () => void;
};

const controllers = new WeakMap<HTMLElement, ActionController>();
const iconPaths: Record<string, string[]> = {
  copy: ["M9 8h10v12H9z", "M15 8V4H5v12h4"],
  check: ["m5 12 4 4L19 6"],
  edit: ["m4 16-1 5 5-1L20 8l-4-4L4 16Z", "m14 6 4 4"],
  regenerate: [
    "M20 7v5h-5",
    "M4 17v-5h5",
    "M6.1 7a7 7 0 0 1 11.6-1L20 9",
    "M17.9 17a7 7 0 0 1-11.6 1L4 15",
  ],
  volume: [
    "M10 4 5 8H2v8h3l5 4V4Z",
    "M14 8a6 6 0 0 1 0 8",
    "M17 5a10 10 0 0 1 0 14",
  ],
  stop: ["M6 6h12v12H6z"],
  up: [
    "M7 21H3V10h4",
    "M7 10l5-8c3 0 3 3 1 7h6a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H7V10Z",
  ],
  down: [
    "M7 3H3v11h4",
    "M7 14l5 8c3 0 3-3 1-7h6a2 2 0 0 0 2-2l-2-8a2 2 0 0 0-2-2H7v11Z",
  ],
};

let activeSpeech: { owner: HTMLElement; stop: () => void } | null = null;

// Truthful message timestamps

export function formatMessageTime(
  createdAt?: number,
  fallbackTimestamp?: number,
): {
  label: string;
  title: string;
  dateTime: string;
} | null {
  const valid = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime());
  const hasCreatedTime = valid(createdAt);
  const value = hasCreatedTime
    ? createdAt
    : valid(fallbackTimestamp)
      ? fallbackTimestamp
      : undefined;

  if (value === undefined) return null;

  const date = new Date(value);
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const full = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);

  return {
    label: hasCreatedTime ? time : `Updated ${time}`,
    title: `${hasCreatedTime ? "Sent" : "Conversation last updated"} ${full}`,
    dateTime: date.toISOString(),
  };
}

function updateTime(
  time: HTMLTimeElement,
  message: ActionMessage,
  options: CommonOptions,
): void {
  const value = formatMessageTime(message.createdAt, options.fallbackTimestamp);

  time.hidden = !value;
  time.textContent = value?.label || "";
  time.dateTime = value?.dateTime || "";
  time.title = value?.title || "";

  if (message.editedAt && value) {
    time.textContent += " · Edited";
    const edited = formatMessageTime(message.editedAt);

    if (edited) time.title += ` · Edited ${edited.title.replace(/^Sent /, "")}`;
  }
}

// Accessible action controls

function icon(name: string): SVGSVGElement {
  const result = document.createElementNS("http://www.w3.org/2000/svg", "svg");

  result.setAttribute("viewBox", "0 0 24 24");
  result.setAttribute("aria-hidden", "true");

  for (const data of iconPaths[name] || []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

    path.setAttribute("d", data);
    result.append(path);
  }

  return result;
}

function action(label: string, symbol: string): HTMLButtonElement {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "message-action-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(symbol));
  return button;
}

function setAction(
  button: HTMLButtonElement,
  label: string,
  symbol: string,
): void {
  button.title = label;
  button.setAttribute("aria-label", label);
  button.replaceChildren(icon(symbol));
}

function report(
  container: HTMLElement,
  options: CommonOptions,
  text: string,
): void {
  if (options.onError) {
    options.onError(text);
    return;
  }

  let output = container.querySelector<HTMLElement>(".message-action-status");

  if (!output) {
    output = document.createElement("p");
    output.className = "message-action-status";
    output.setAttribute("role", "status");
    container.append(output);
  }

  output.textContent = text;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Legacy clipboard fallback */
    }
  }

  const previous = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_unused, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement("textarea");

  textarea.className = "message-copy-buffer";
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-label", "Copy message");
  document.body.append(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    if (!document.execCommand("copy")) throw new Error("Copy unavailable");
  } finally {
    textarea.remove();

    if (previous instanceof HTMLElement)
      previous.focus({ preventScroll: true });

    if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

function bindCopy(
  button: HTMLButtonElement,
  container: HTMLElement,
  current: () => ActionController,
  renderedText?: () => string,
): void {
  let reset: ReturnType<typeof setTimeout> | undefined;

  button.addEventListener("click", async () => {
    const controller = current();

    try {
      await copyText(renderedText ? renderedText() : controller.message.text);
      clearTimeout(reset);
      setAction(button, "Copied", "check");
      button.classList.add("is-copied");
      reset = setTimeout(() => {
        setAction(button, "Copy message", "copy");
        button.classList.remove("is-copied");
      }, 1600);
    } catch {
      report(
        container,
        controller.options,
        "Could not copy this message. Select the text and copy it instead.",
      );
    }
  });
}

export function refreshMessageActions(): void {
  for (const container of document.querySelectorAll<HTMLElement>(
    ".user-message-row, .assistant-message",
  )) {
    controllers.get(container)?.refresh();
  }
}

// Inline user message editor

export function attachUserMessageActions(
  container: HTMLElement,
  message: ActionMessage,
  options: UserOptions,
): void {
  const existing = controllers.get(container);

  if (existing) {
    existing.message = message;
    existing.options = options;
    existing.refresh();
    return;
  }

  container.classList.add("message-row", "user-message-row");
  const bubble = container.matches(".message-bubble")
    ? container
    : container.querySelector<HTMLElement>(".message-bubble");
  const bar = document.createElement("div");
  const time = document.createElement("time");
  const edit = action("Edit message", "edit");
  const copy = action("Copy message", "copy");
  let editor: HTMLDivElement | null = null;
  let saving = false;

  bar.className = "message-actions-bar user-message-actions";
  time.className = "message-timestamp";
  bar.append(time, edit, copy);
  container.append(bar);

  const controller: ActionController = {
    message,
    options,
    refresh() {
      updateTime(time, controller.message, controller.options);
      edit.disabled = saving || controller.options.isBusy();
      copy.disabled = !controller.message.text;
      bar.hidden = Boolean(editor);
    },
  };

  controllers.set(container, controller);
  bindCopy(copy, container, () => controller);

  function closeEditor(): void {
    if (!editor) return;

    editor.remove();
    editor = null;
    container.classList.remove("is-editing");
    if (bubble && bubble !== container) bubble.hidden = false;
    controller.refresh();
  }

  edit.addEventListener("click", () => {
    if (controller.options.isBusy() || saving || editor) return;

    const panel = document.createElement("div");
    const field = document.createElement("textarea");
    const buttons = document.createElement("div");
    const consequence = document.createElement("p");
    const cancel = document.createElement("button");
    const save = document.createElement("button");
    const error = document.createElement("p");

    panel.className = "message-edit-panel";
    field.className = "message-edit-input";
    field.value = controller.message.text;
    field.rows = Math.max(
      3,
      Math.min(10, controller.message.text.split("\n").length + 1),
    );
    field.setAttribute("aria-label", "Edit your message");
    buttons.className = "message-edit-actions";
    consequence.className = "message-edit-consequence";
    consequence.textContent = "Following replies will be regenerated";
    cancel.type = "button";
    cancel.className = "message-edit-cancel";
    cancel.textContent = "Cancel";
    save.type = "button";
    save.className = "message-edit-save";
    save.textContent = "Save & Send";
    error.className = "message-edit-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    buttons.append(cancel, save);
    panel.append(field);

    if (controller.message.files?.length) {
      const files = document.createElement("div");

      files.className = "message-edit-files";

      for (const file of controller.message.files) {
        const name = document.createElement("span");

        name.textContent = file.name;
        files.append(name);
      }

      panel.append(files);
    }

    panel.append(error, consequence, buttons);
    editor = panel;
    container.classList.add("is-editing");
    if (bubble && bubble !== container) bubble.hidden = true;
    container.append(panel);
    controller.refresh();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);

    cancel.addEventListener("click", () => {
      closeEditor();
      edit.focus();
    });
    field.addEventListener("input", () => {
      error.hidden = true;
      field.removeAttribute("aria-invalid");
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        closeEditor();
        edit.focus();
      }

      if (
        event.key === "Enter" &&
        (event.ctrlKey || event.metaKey) &&
        !event.isComposing
      ) {
        event.preventDefault();
        save.click();
      }
    });
    save.addEventListener("click", async () => {
      if (saving || controller.options.isBusy()) return;

      const value = field.value.trim();

      if (!value || value.length > 30000) {
        error.textContent = !value
          ? "Enter a message before sending"
          : "Use no more than 30,000 characters";
        error.hidden = false;
        field.setAttribute("aria-invalid", "true");
        field.focus();
        return;
      }

      saving = true;
      save.disabled = true;
      cancel.disabled = true;
      field.disabled = true;
      save.textContent = "Sending…";

      try {
        await (controller.options as UserOptions).onEdit(value);
        closeEditor();
      } catch (failure) {
        error.textContent =
          failure instanceof Error
            ? failure.message
            : "Could not resend this message. Try again.";
        error.hidden = false;
      } finally {
        saving = false;
        save.disabled = false;
        cancel.disabled = false;
        field.disabled = false;
        save.textContent = "Save & Send";
        controller.refresh();
      }
    });
  });

  controller.refresh();
}

// Read aloud lifecycle

export function splitSpeechText(text: string, maximum = 1600): string[] {
  const size = Math.max(2, Math.min(1600, Math.floor(maximum) || 1600));
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > size) {
    const candidate = remaining.slice(0, size);
    const sentence = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("? "),
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf("\n"),
    );
    let end = sentence > size / 2 ? sentence + 1 : size;

    if (end === size) {
      const space = candidate.lastIndexOf(" ");

      if (space > size / 2) end = space + 1;
    }

    const last = remaining.charCodeAt(end - 1);

    if (last >= 0xd800 && last <= 0xdbff) end -= 1;

    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function stopMessageSpeech(): void {
  activeSpeech?.stop();
}

function beginSpeech(
  owner: HTMLElement,
  text: string,
  button: HTMLButtonElement,
  options: CommonOptions,
): void {
  if (
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  )
    return;

  stopMessageSpeech();
  const chunks = splitSpeechText(text);
  const synthesis = window.speechSynthesis;
  let index = 0;
  let stopped = false;
  let utterance: SpeechSynthesisUtterance | null = null;

  function stop(): void {
    if (stopped) return;

    stopped = true;
    if (activeSpeech?.owner === owner) activeSpeech = null;
    synthesis.cancel();
    setAction(button, "Read aloud", "volume");
    button.setAttribute("aria-pressed", "false");
    observer.disconnect();
  }

  const observer = new MutationObserver(() => {
    if (!owner.isConnected) stop();
  });

  function next(): void {
    if (stopped) return;

    if (index >= chunks.length) {
      stopped = true;
      if (activeSpeech?.owner === owner) activeSpeech = null;
      setAction(button, "Read aloud", "volume");
      button.setAttribute("aria-pressed", "false");
      observer.disconnect();
      return;
    }

    utterance = new SpeechSynthesisUtterance(chunks[index++]);
    utterance.onend = next;
    utterance.onerror = (event) => {
      if (stopped) return;

      if (["canceled", "interrupted"].includes(event.error)) {
        stop();
        return;
      }

      stop();
      report(
        owner,
        options,
        "Read aloud is unavailable. Check your browser audio settings and try again.",
      );
    };

    try {
      synthesis.speak(utterance);
    } catch {
      stop();
      report(owner, options, "Read aloud could not start in this browser.");
    }
  }

  activeSpeech = { owner, stop };
  observer.observe(document.body, { childList: true, subtree: true });
  setAction(button, "Stop reading", "stop");
  button.setAttribute("aria-pressed", "true");
  next();
}

// Assistant reply controls

export function attachAssistantMessageActions(
  article: HTMLElement,
  message: ActionMessage,
  options: AssistantOptions,
): void {
  const existing = controllers.get(article);

  if (existing) {
    existing.message = message;
    existing.options = options;
    existing.refresh();
    return;
  }

  const content =
    article.querySelector<HTMLElement>(".assistant-content") || article;
  const bar = document.createElement("div");
  const copy = action("Copy message", "copy");
  const regenerate = action("Regenerate reply", "regenerate");
  const read = action("Read aloud", "volume");
  const up = action("Good response", "up");
  const down = action("Bad response", "down");
  const time = document.createElement("time");
  let regenerating = false;
  let feedbackPending = false;
  const supportsSpeech =
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined";

  bar.className = "message-actions-bar assistant-message-actions";
  time.className = "message-timestamp";
  read.setAttribute("aria-pressed", "false");
  up.setAttribute("aria-pressed", "false");
  down.setAttribute("aria-pressed", "false");
  bar.append(copy, regenerate, read, up, down, time);
  content.append(bar);

  const controller: ActionController = {
    message,
    options,
    refresh() {
      const current = controller.message;
      const hasText = Boolean(current.text.trim());

      bar.hidden = current.state === "pending";
      copy.hidden = !hasText;
      read.hidden = !hasText || !supportsSpeech;
      up.hidden = !hasText;
      down.hidden = !hasText;
      regenerate.disabled = regenerating || controller.options.isBusy();
      read.disabled =
        controller.options.isBusy() && activeSpeech?.owner !== article;
      up.disabled = feedbackPending;
      down.disabled = feedbackPending;
      up.setAttribute("aria-pressed", String(current.feedback === "up"));
      down.setAttribute("aria-pressed", String(current.feedback === "down"));

      const label = ["error", "stopped"].includes(current.state || "")
        ? "Retry reply"
        : "Regenerate reply";

      regenerate.title = label;
      regenerate.setAttribute("aria-label", label);
      updateTime(time, current, controller.options);
    },
  };

  controllers.set(article, controller);
  const renderedText = (): string => {
    const body = article.querySelector<HTMLElement>(".assistant-text");

    return body?.innerText?.trim() || controller.message.text;
  };

  bindCopy(copy, article, () => controller, renderedText);
  regenerate.addEventListener("click", async () => {
    if (controller.options.isBusy() || regenerating) return;

    if (activeSpeech?.owner === article) stopMessageSpeech();

    regenerating = true;
    controller.refresh();

    try {
      await (controller.options as AssistantOptions).onRegenerate();
    } catch (error) {
      report(
        article,
        controller.options,
        error instanceof Error
          ? error.message
          : "Could not regenerate this reply. Try again.",
      );
    } finally {
      regenerating = false;
      controller.refresh();
    }
  });
  read.addEventListener("click", () => {
    if (activeSpeech?.owner === article) {
      stopMessageSpeech();
      return;
    }
    if (controller.options.isBusy()) return;

    const text = renderedText();

    if (text) beginSpeech(article, text, read, controller.options);
  });

  for (const [button, choice] of [
    [up, "up"],
    [down, "down"],
  ] as const) {
    button.addEventListener("click", async () => {
      if (feedbackPending) return;

      const value = controller.message.feedback === choice ? undefined : choice;

      feedbackPending = true;
      controller.refresh();

      try {
        await (controller.options as AssistantOptions).onFeedback(value);
        controller.message.feedback = value;
      } catch (error) {
        report(
          article,
          controller.options,
          error instanceof Error
            ? error.message
            : "Your feedback could not be saved. Please try again.",
        );
      } finally {
        feedbackPending = false;
        controller.refresh();
      }
    });
  }

  controller.refresh();
}
