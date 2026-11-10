export type SidebarChat = {
  id: string;
  provider: string;
  title: string;
  updated: number;
  lastSentAt?: number;
  messages?: readonly {
    role?: string;
    createdAt?: number;
    editedAt?: number;
  }[];
  saved?: boolean;
  archived?: boolean;
};

type SidebarOptions = {
  getChats: () => SidebarChat[];
  getProvider: () => string;
  getCurrentChatId: () => string | null | undefined;
  onOpen: (id: string) => void;
  onChange: () => void;
  onDelete: (id: string) => void;
  onShare: (id: string) => Promise<void> | void;
  onError?: (message: string) => void;
};

export type SidebarController = {
  render: () => void;
  clearSearch: () => void;
  renderArchiveMemory: () => void;
  showArchived: () => void;
  destroy: () => void;
};

// Last sent message order

export function chatSortTimestamp(chat: SidebarChat): number {
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

  if (valid(chat.lastSentAt)) return chat.lastSentAt;

  let lastSent = 0;
  let hasMessageTime = false;

  for (const message of chat.messages || []) {
    if (message.role !== "user") continue;

    for (const timestamp of [message.createdAt, message.editedAt]) {
      if (!valid(timestamp)) continue;

      hasMessageTime = true;
      lastSent = Math.max(lastSent, timestamp);
    }
  }

  return hasMessageTime ? lastSent : valid(chat.updated) ? chat.updated : 0;
}

// Title matching

function normalizeTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];

    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;

      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );

      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        current[column] = Math.min(
          current[column],
          previousPrevious[column - 2] + 1,
        );
      }
    }

    previousPrevious = previous;
    previous = current;
  }

  return previous[b.length];
}

export function titleMatchScore(title: string, query: string): number | null {
  const name = normalizeTitle(title);
  const term = normalizeTitle(query);

  if (!term) return 0;
  if (name === term) return 0;
  if (name.startsWith(term)) return 10 + (name.length - term.length) / 1000;

  const index = name.indexOf(term);

  if (index !== -1)
    return 20 + Math.min(index, 100) / 100 + name.length / 10000;

  const terms = term.match(/[\p{L}\p{N}]+/gu) || [];
  const words = name.match(/[\p{L}\p{N}]+/gu) || [];

  if (!terms.length || !words.length) return null;

  let distance = 0;

  for (const token of terms) {
    if (words.some((word) => word.includes(token))) continue;
    if (token.length < 3 || token.length > 80) return null;

    const allowance = Math.min(2, Math.max(1, Math.floor(token.length / 4)));
    let closest = allowance + 1;

    for (const word of words) {
      if (Math.abs(word.length - token.length) > allowance || word.length > 80)
        continue;

      closest = Math.min(closest, editDistance(token, word));
    }

    if (closest > allowance) return null;

    distance += closest;
  }

  return (distance ? 40 + distance : 30) + name.length / 10000;
}

export function rankChatTitles<T extends SidebarChat>(
  chats: readonly T[],
  query: string,
): T[] {
  return chats
    .map((chat) => ({ chat, score: titleMatchScore(chat.title, query) }))
    .filter(
      (entry): entry is { chat: T; score: number } => entry.score !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score ||
        chatSortTimestamp(right.chat) - chatSortTimestamp(left.chat) ||
        left.chat.title.localeCompare(right.chat.title) ||
        left.chat.id.localeCompare(right.chat.id),
    )
    .map((entry) => entry.chat);
}

export function selectSidebarChats<T extends SidebarChat>(
  chats: readonly T[],
  provider: string,
  query = "",
  archived = false,
): { saved: T[]; recents: T[] } {
  const visible = chats.filter(
    (chat) => chat.provider === provider && Boolean(chat.archived) === archived,
  );

  if (query.trim())
    return { saved: [], recents: rankChatTitles(visible, query) };

  const ordered = [...visible].sort(
    (left, right) =>
      chatSortTimestamp(right) - chatSortTimestamp(left) ||
      left.id.localeCompare(right.id),
  );

  return archived
    ? { saved: [], recents: ordered }
    : {
        saved: ordered.filter((chat) => chat.saved),
        recents: ordered.filter((chat) => !chat.saved),
      };
}

// Sidebar lifecycle

const controllers = new WeakMap<HTMLInputElement, SidebarController>();

export function initChatSidebar(options: SidebarOptions): SidebarController {
  function required<T extends HTMLElement = HTMLElement>(id: string): T {
    const result = document.getElementById(id);

    if (!result) throw new Error(`Missing sidebar element: ${id}`);

    return result as T;
  }

  const search = required<HTMLInputElement>("chat-search");
  const existing = controllers.get(search);

  if (existing) return existing;

  const recent = required("recent-chats");
  const saved = required("saved-chats");
  const savedSection = required("saved-section");
  const empty = required("history-empty");
  const noResults = required("no-results");
  const sectionTitle = document.getElementById("recent-section-title");
  const archiveToggle = document.getElementById("archived-chats-toggle");
  const archiveList = document.getElementById("memory-archived-list");
  const memoryDialog = document.getElementById(
    "memory-dialog",
  ) as HTMLDialogElement | null;
  const lifecycle = new AbortController();
  const listener = { signal: lifecycle.signal };
  const animations = new Map<HTMLElement, Animation>();
  const menu = document.createElement("div");
  const dialog = document.createElement("dialog");

  let query = "";
  let archiveExpanded = false;
  let menuChatId: string | null = null;
  let menuInvoker: HTMLElement | null = null;
  let dialogChatId: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let notice: HTMLElement | null = null;

  menu.className = "chat-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Chat actions");
  menu.hidden = true;
  dialog.className = "sidebar-action-dialog";
  document.body.append(menu, dialog);

  function chatById(id: string): SidebarChat | undefined {
    return options.getChats().find((chat) => chat.id === id);
  }

  function reportError(message: string): void {
    if (options.onError) {
      options.onError(message);
      return;
    }

    clearTimeout(noticeTimer);
    notice?.remove();
    notice = document.createElement("p");
    notice.className = "sidebar-notice";
    notice.setAttribute("role", "status");
    notice.textContent = message;
    document.body.append(notice);
    noticeTimer = setTimeout(() => {
      notice?.remove();
      notice = null;
    }, 4500);
  }

  function button(className: string, label: string): HTMLButtonElement {
    const result = document.createElement("button");

    result.type = "button";
    result.className = className;
    result.setAttribute("aria-label", label);
    return result;
  }

  function icon(name: "star" | "delete" | "restore"): SVGSVGElement {
    const result = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const shapes = {
      star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z",
      delete: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
      restore: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
    };

    result.setAttribute("viewBox", "0 0 24 24");
    result.setAttribute("aria-hidden", "true");
    path.setAttribute("d", shapes[name]);
    result.append(path);
    return result;
  }

  function closeMenu(restoreFocus = false): void {
    menu.hidden = true;
    menuChatId = null;

    if (restoreFocus && menuInvoker?.isConnected) menuInvoker.focus();
  }

  function restoreRowFocus(id: string): void {
    if (memoryDialog?.open) {
      const row = [
        ...(archiveList?.querySelectorAll<HTMLElement>(".memory-archive-row") ||
          []),
      ].find((element) => element.dataset.chatId === id);

      if (row)
        row.querySelector<HTMLButtonElement>(".memory-archive-open")?.focus();
      else archiveToggle?.focus();

      return;
    }

    const row = [
      ...document.querySelectorAll<HTMLElement>(".chat-managed-row"),
    ].find((element) => element.dataset.chatId === id);

    row?.querySelector<HTMLButtonElement>(".history-item")?.focus();
  }

  function changed(id: string): void {
    options.onChange();
    render();
    restoreRowFocus(id);
  }

  function dialogShell(title: string, description: string): HTMLDivElement {
    closeMenu();
    dialog.replaceChildren();

    const heading = document.createElement("h2");
    const copy = document.createElement("p");
    const content = document.createElement("div");

    heading.id = "sidebar-action-title";
    heading.textContent = title;
    copy.id = "sidebar-action-description";
    copy.textContent = description;
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", copy.id);
    dialog.append(heading, copy, content);
    return content;
  }

  function renameChat(id: string): void {
    const chat = chatById(id);

    if (!chat) return;

    dialogChatId = id;

    const content = dialogShell(
      "Rename chat",
      "Give this conversation a name.",
    );
    const form = document.createElement("form");
    const label = document.createElement("label");
    const field = document.createElement("input");
    const actions = document.createElement("div");
    const cancel = button("sidebar-dialog-secondary", "Cancel");
    const submit = button("sidebar-dialog-primary", "Save name");

    label.htmlFor = "sidebar-chat-name";
    label.textContent = "Chat name";
    field.id = label.htmlFor;
    field.value = chat.title;
    field.maxLength = 180;
    field.required = true;
    field.autocomplete = "off";
    submit.type = "submit";
    cancel.textContent = "Cancel";
    submit.textContent = "Save";
    actions.className = "sidebar-dialog-actions";
    actions.append(cancel, submit);
    form.append(label, field, actions);
    content.append(form);

    cancel.addEventListener("click", () => dialog.close());
    field.addEventListener("input", () => field.setCustomValidity(""));
    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const title = field.value.trim().replace(/\s+/g, " ");

      if (!title) {
        field.setCustomValidity("Enter a chat name");
        field.reportValidity();
        return;
      }

      const current = chatById(id);

      if (current) current.title = title;

      dialog.close();
      changed(id);
    });
    dialog.showModal();
    field.focus();
    field.select();
  }

  function deleteChat(id: string): void {
    const chat = chatById(id);

    if (!chat) return;

    dialogChatId = id;

    const content = dialogShell(
      "Permanently delete chat?",
      `“${chat.title}” will be removed. This cannot be undone.`,
    );
    const actions = document.createElement("div");
    const cancel = button("sidebar-dialog-secondary", "Cancel");
    const confirm = button(
      "sidebar-dialog-primary is-destructive",
      "Permanently delete chat",
    );

    actions.className = "sidebar-dialog-actions";
    cancel.textContent = "Cancel";
    confirm.textContent = "Delete chat";
    actions.append(cancel, confirm);
    content.append(actions);
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => {
      dialog.close();

      if (chatById(id)) options.onDelete(id);

      render();
    });
    dialog.showModal();
    cancel.focus();
  }

  async function shareChat(id: string): Promise<void> {
    closeMenu(true);

    try {
      await options.onShare(id);
    } catch (error) {
      reportError(
        error instanceof Error
          ? error.message
          : "Could not share this chat. Please try again.",
      );
    }
  }

  function openMenu(
    id: string,
    invoker: HTMLElement,
    x: number,
    y: number,
  ): void {
    const chat = chatById(id);

    if (!chat) return;

    menu.replaceChildren();
    menuChatId = id;
    menuInvoker = invoker;

    const actions = [
      { label: "Rename", action: () => renameChat(id) },
      {
        label: "Share",
        action: () => {
          void shareChat(id);
        },
      },
      {
        label: chat.archived ? "Restore" : "Archive",
        action: () => {
          const current = chatById(id);

          if (current) current.archived = !current.archived;

          closeMenu();
          changed(id);
        },
      },
      { label: "Permanently delete", action: () => deleteChat(id) },
    ];

    for (const action of actions) {
      const item = button("chat-context-action", action.label);

      item.textContent = action.label;
      item.setAttribute("role", "menuitem");

      if (action.label === "Permanently delete")
        item.classList.add("is-destructive");

      item.addEventListener("click", action.action);
      menu.append(item);
    }

    const host = invoker.closest("dialog");

    if (host) host.append(menu);
    else document.body.append(menu);

    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";

    const bounds = menu.getBoundingClientRect();

    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }

  function createRow(chat: SidebarChat): HTMLElement {
    const row = document.createElement("div");
    const open = button("history-item", chat.title);
    const clip = document.createElement("span");
    const title = document.createElement("span");
    const actions = document.createElement("div");

    row.className = `history-row chat-managed-row${options.getCurrentChatId() === chat.id ? " is-active" : ""}`;
    row.dataset.chatId = chat.id;
    open.title = chat.title;
    clip.className = "history-title-clip";
    title.className = "history-title-text";
    title.textContent = chat.title;
    clip.append(title);
    open.append(clip);
    open.addEventListener("click", () => options.onOpen(chat.id));
    actions.className = "history-row-actions";

    if (chat.archived) {
      const restore = button(
        "history-row-action history-restore-action",
        `Restore chat: ${chat.title}`,
      );

      restore.title = "Restore chat";
      restore.append(icon("restore"));
      restore.addEventListener("click", () => {
        const current = chatById(chat.id);

        if (current) current.archived = false;

        changed(chat.id);
      });
      actions.append(restore);
    } else {
      const star = button(
        `history-row-action history-save-action${chat.saved ? " is-saved" : ""}`,
        `${chat.saved ? "Unsave" : "Save"} chat: ${chat.title}`,
      );

      star.title = chat.saved ? "Unsave chat" : "Save chat";
      star.setAttribute("aria-pressed", String(Boolean(chat.saved)));
      star.append(icon("star"));
      star.addEventListener("click", () => {
        const current = chatById(chat.id);

        if (current) current.saved = !current.saved;

        changed(chat.id);
      });
      actions.append(star);
    }

    const remove = button(
      "history-row-action history-remove-action",
      `Delete chat: ${chat.title}`,
    );

    remove.title = "Delete chat";
    remove.append(icon("delete"));
    remove.addEventListener("click", () => deleteChat(chat.id));
    actions.append(remove);
    row.append(open, actions);

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(chat.id, open, event.clientX, event.clientY);
    });
    row.addEventListener("keydown", (event) => {
      if (
        event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)
      ) {
        event.preventDefault();

        const bounds = row.getBoundingClientRect();

        openMenu(chat.id, open, bounds.left + 18, bounds.bottom);
      }
    });
    row.addEventListener("pointerenter", () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const overflow = title.scrollWidth - clip.clientWidth;

      if (overflow < 2) return;

      title.style.maxWidth = "none";

      const animation = title.animate(
        [
          { transform: "translateX(0)" },
          { transform: `translateX(-${overflow}px)` },
        ],
        {
          duration: Math.min(9000, Math.max(1500, overflow * 30)),
          delay: 350,
          easing: "linear",
          iterations: 1,
          fill: "forwards",
        },
      );

      animations.set(title, animation);
    });
    row.addEventListener("pointerleave", () => {
      animations.get(title)?.cancel();
      animations.delete(title);
      title.style.maxWidth = "";
    });

    return row;
  }

  // Visible sections

  function renderArchiveMemory(): void {
    if (!archiveToggle || !archiveList) return;

    const archived = options
      .getChats()
      .filter((chat) => chat.archived)
      .sort(
        (left, right) =>
          chatSortTimestamp(right) - chatSortTimestamp(left) ||
          left.id.localeCompare(right.id),
      );
    const names: Record<string, string> = {
      openai: "ChatGPT",
      gemini: "Gemini",
      claude: "Claude",
      deepseek: "DeepSeek",
      grok: "Grok",
      perplexity: "Perplexity",
    };

    archiveToggle.textContent = `Archived${archived.length ? ` (${archived.length})` : ""}`;
    archiveToggle.setAttribute("aria-expanded", String(archiveExpanded));
    archiveList.hidden = !archiveExpanded;
    archiveList.replaceChildren();

    if (!archived.length) {
      const hint = document.createElement("p");

      hint.className = "memory-archive-empty";
      hint.textContent = "No archived chats";
      archiveList.append(hint);
      return;
    }

    for (const chat of archived) {
      const row = document.createElement("article");
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      const provider = document.createElement("span");
      const actions = document.createElement("div");
      const open = button(
        "memory-archive-open",
        `Open archived chat: ${chat.title}`,
      );
      const restore = button(
        "memory-archive-restore",
        `Restore chat: ${chat.title}`,
      );
      const more = button(
        "memory-archive-more",
        `More actions for archived chat: ${chat.title}`,
      );

      row.className = "memory-archive-row";
      row.dataset.chatId = chat.id;
      heading.className = "memory-archive-heading";
      title.textContent = chat.title;
      title.title = chat.title;
      provider.textContent = names[chat.provider] || chat.provider;
      actions.className = "memory-archive-actions";
      open.textContent = "Open";
      restore.textContent = "Restore";
      more.textContent = "···";
      more.setAttribute("aria-haspopup", "menu");
      open.addEventListener("click", () => {
        closeMenu();
        memoryDialog?.close();
        options.onOpen(chat.id);
      });
      restore.addEventListener("click", () => {
        const current = chatById(chat.id);

        if (current) current.archived = false;

        changed(chat.id);
      });
      more.addEventListener("click", () => {
        const bounds = more.getBoundingClientRect();

        openMenu(chat.id, more, bounds.left, bounds.bottom + 4);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openMenu(chat.id, open, event.clientX, event.clientY);
      });
      row.addEventListener("keydown", (event) => {
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();

          const bounds = row.getBoundingClientRect();

          openMenu(chat.id, open, bounds.left + 12, bounds.bottom);
        }
      });
      heading.append(title, provider);
      actions.append(open, restore, more);
      row.append(heading, actions);
      archiveList.append(row);
    }
  }

  function render(): void {
    closeMenu();

    for (const animation of animations.values()) animation.cancel();

    animations.clear();

    const chats = options.getChats();
    const result = selectSidebarChats(
      chats,
      options.getProvider(),
      query,
      false,
    );
    const searching = Boolean(query.trim());

    recent.replaceChildren(...result.recents.map(createRow));
    saved.replaceChildren(...result.saved.map(createRow));
    savedSection.hidden = searching;

    if (!result.saved.length && !savedSection.hidden) {
      const hint = document.createElement("p");

      hint.className = "sidebar-saved-empty";
      hint.textContent = "No saved chats";
      saved.append(hint);
    }

    if (sectionTitle)
      sectionTitle.textContent = searching ? "Search results" : "Recents";

    noResults.hidden = !searching || result.recents.length > 0;
    empty.hidden = searching || result.recents.length > 0;
    empty.textContent = result.saved.length
      ? "No recent chats"
      : "No chats yet";
    renderArchiveMemory();
  }

  function clearSearch(): void {
    search.value = "";
    query = "";
    render();
  }

  search.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        query = search.value.trim();
        render();
      } else if (event.key === "Escape" && search.value) {
        event.preventDefault();
        clearSearch();
      }
    },
    listener,
  );
  search.addEventListener(
    "input",
    () => {
      if (!search.value.trim()) {
        query = "";
        render();
      }
    },
    listener,
  );
  archiveToggle?.addEventListener(
    "click",
    () => {
      archiveExpanded = !archiveExpanded;
      closeMenu();
      renderArchiveMemory();
    },
    listener,
  );

  menu.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (event.key === "Tab") {
        closeMenu();
        return;
      }

      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();

        const items = [
          ...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;

        items[next]?.focus();
      }
    },
    listener,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!menu.hidden && !menu.contains(event.target as Node)) closeMenu();
    },
    listener,
  );
  window.addEventListener("resize", () => closeMenu(), listener);
  window.addEventListener("scroll", () => closeMenu(), {
    ...listener,
    capture: true,
  });
  dialog.addEventListener(
    "close",
    () => {
      if (dialogChatId) restoreRowFocus(dialogChatId);
    },
    listener,
  );
  memoryDialog?.addEventListener("close", () => closeMenu(), listener);

  const controller: SidebarController = {
    render,
    clearSearch,
    renderArchiveMemory,
    showArchived() {
      archiveExpanded = true;
      renderArchiveMemory();
      if (memoryDialog && !memoryDialog.open) memoryDialog.showModal();
    },
    destroy() {
      lifecycle.abort();
      closeMenu();
      for (const animation of animations.values()) animation.cancel();
      clearTimeout(noticeTimer);
      menu.remove();
      dialog.remove();
      notice?.remove();
      controllers.delete(search);
    },
  };

  controllers.set(search, controller);
  render();
  return controller;
}
