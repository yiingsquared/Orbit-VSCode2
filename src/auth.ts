export type OrbitUser = {
  id: string;
  email: string;
  name: string;
  provider: "email" | "google";
  emailVerified: boolean;
};

type AuthSession = {
  user: OrbitUser | null;
};

type EmailStep = { step: "signup" | "login" | "google"; email: string };

export type AuthChangeMeta = {
  source: "initial" | "signup" | "login" | "oauth" | "logout";
  isNewAccount: boolean;
};

export type AuthOptions = {
  onChange?: (user: OrbitUser | null, meta: AuthChangeMeta) => void;
  beforeSignOut?: () => void | Promise<void>;
  showAccountAfterOAuth?: boolean;
};

export type AuthController = {
  ready: Promise<OrbitUser | null>;
  getUser: () => OrbitUser | null;
  open: () => void;
  close: () => void;
  signOut: () => Promise<void>;
};

const authControllers = new WeakMap<
  HTMLDialogElement,
  {
    controller: AuthController;
    configure: (options: AuthOptions) => void;
  }
>();

const googleUnavailableMessage =
  "Google sign-in is temporarily unavailable. Continue with email or try again later.";

// Local account dialog

export function initAuth(options: AuthOptions = {}): AuthController {
  const trigger = document.getElementById(
    "rail-auth-button",
  ) as HTMLButtonElement | null;
  const dialog = document.getElementById(
    "auth-dialog",
  ) as HTMLDialogElement | null;

  if (!trigger || !dialog)
    return {
      ready: Promise.resolve(null),
      getUser: () => null,
      open: () => {},
      close: () => {},
      signOut: async () => {},
    };

  const existing = authControllers.get(dialog);

  if (existing) {
    existing.configure(options);
    return existing.controller;
  }

  const authButton = trigger;
  const authDialog = dialog;
  let user: OrbitUser | null = null;
  let email = "";
  let busy = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let signingOut: Promise<void> | null = null;
  let settings = options;

  function node<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text = "",
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);

    if (className) element.className = className;
    if (text) element.textContent = text;

    return element;
  }

  function button(className: string, text: string): HTMLButtonElement {
    const element = node("button", className, text);

    element.type = "button";
    return element;
  }

  function setUser(next: OrbitUser | null, meta?: AuthChangeMeta): void {
    user = next;
    authButton.replaceChildren();

    if (next) {
      const avatar = node(
        "span",
        "rail-account-avatar",
        next.email.trim().slice(0, 1).toUpperCase(),
      );

      avatar.setAttribute("aria-hidden", "true");
      authButton.append(avatar);
    } else {
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      const symbol = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "use",
      );

      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      symbol.setAttribute("href", "#i-user");
      icon.append(symbol);
      authButton.append(icon);
    }

    authButton.title = next ? next.email : "Log in or create an Orbit account";
    authButton.setAttribute(
      "aria-label",
      next ? `Your account: ${next.email}` : "Log in or sign up",
    );
    authButton.classList.toggle("is-signed-in", Boolean(next));
    if (meta) {
      window.dispatchEvent(
        new CustomEvent("orbit:authchange", { detail: next }),
      );

      try {
        Promise.resolve(settings.onChange?.(next, meta)).catch(() => {
          window.dispatchEvent(new CustomEvent("orbit:authflowerror"));
        });
      } catch {
        window.dispatchEvent(new CustomEvent("orbit:authflowerror"));
      }
    }
  }

  function showError(message: string, validation = false): void {
    const target = authDialog.querySelector<HTMLElement>(".auth-error");

    if (!target) return;

    target.textContent = message;
    target.hidden = !message;
    target.classList.toggle("auth-validation", validation);
  }

  function setBusy(next: boolean, label = ""): void {
    busy = next;
    authDialog.setAttribute("aria-busy", String(next));

    for (const control of authDialog.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >("button:not(.dialog-close), input")) {
      control.disabled = next;
    }

    const submit = authDialog.querySelector<HTMLButtonElement>(".auth-primary");

    if (submit) {
      if (!submit.dataset.idleLabel)
        submit.dataset.idleLabel = submit.textContent || "";
      submit.textContent = next && label ? label : submit.dataset.idleLabel;
    }
  }

  async function post<T>(
    path: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
      signal,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw Object.assign(
        new Error(
          data.message ||
            `Could not complete this request (${response.status}).`,
        ),
        {
          code: typeof data.code === "string" ? data.code : "",
        },
      );
    }

    return data as T;
  }

  async function run(
    action: (signal: AbortSignal) => Promise<void>,
    label = "",
  ): Promise<void> {
    if (busy) return;

    const requestGeneration = ++generation;
    const request = new AbortController();

    controller = request;
    showError("");
    setBusy(true, label);

    try {
      await action(request.signal);
    } catch (error) {
      if (!request.signal.aborted && generation === requestGeneration) {
        const code =
          error instanceof Error && "code" in error ? String(error.code) : "";

        showError(
          code === "google_not_configured"
            ? googleUnavailableMessage
            : error instanceof Error
              ? error.message
              : "Could not reach Orbit. Please try again.",
          ["password_too_short", "password_too_long"].includes(code),
        );
      }
    } finally {
      if (generation === requestGeneration) {
        controller = null;
        setBusy(false);

        if (
          authDialog.open &&
          (!authDialog.contains(document.activeElement) ||
            document.activeElement === authDialog)
        ) {
          authDialog.querySelector<HTMLInputElement>("input")?.focus();
        }
      }
    }
  }

  function shell(title: string, description: string): HTMLElement {
    authDialog.replaceChildren();

    const close = button("dialog-close", "×");
    const brand = node("div", "auth-brand");
    const cat = node("img");
    const heading = node("h2", "auth-heading", title);
    const copy = node("p", "auth-copy", description);
    const content = node("div", "auth-content");
    const error = node("p", "auth-error");

    close.setAttribute("aria-label", "Close login");
    close.addEventListener("click", () => authDialog.close());
    cat.src = "/assets/orbit-cat.svg";
    cat.alt = "";
    brand.append(cat, "Orbit");
    heading.id = "auth-title";
    copy.id = "auth-description";
    error.hidden = true;
    error.setAttribute("role", "alert");
    error.setAttribute("aria-live", "polite");
    authDialog.setAttribute("aria-describedby", "auth-description");
    const scroll = node("div", "dialog-scroll");

    scroll.append(close, brand, heading, copy, content, error);
    authDialog.append(scroll);
    return content;
  }

  function googleLogo(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "auth-google-mark");

    const paths = [
      [
        "#4285F4",
        "M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.31 2.98-7.36Z",
      ],
      [
        "#34A853",
        "M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.81-1.76-5.6-4.13H3.05v2.59A10 10 0 0 0 12 22Z",
      ],
      [
        "#FBBC05",
        "M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z",
      ],
      [
        "#EA4335",
        "M12 5.95c1.47 0 2.78.5 3.82 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59A5.99 5.99 0 0 1 12 5.95Z",
      ],
    ];

    for (const [fill, data] of paths) {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );

      path.setAttribute("fill", fill);
      path.setAttribute("d", data);
      svg.append(path);
    }

    return svg;
  }

  function googleButton(): HTMLButtonElement {
    const google = button("auth-google-button", "");

    google.append(googleLogo(), "Continue with Google");
    google.addEventListener("click", () => {
      void run(async (signal) => {
        const result = await post<{ url: string }>("google", {}, signal);
        const destination = new URL(result.url);

        if (
          destination.protocol !== "https:" ||
          destination.hostname !== "accounts.google.com" ||
          destination.pathname !== "/o/oauth2/v2/auth"
        ) {
          throw new Error("Orbit received an invalid Google sign-in address.");
        }

        window.location.assign(destination.href);
      }, "Opening Google…");
    });

    return google;
  }

  function emailView(): void {
    const content = shell("Welcome to Orbit", "Log in or create your account");
    const divider = node("div", "auth-divider", "or continue with email");
    const form = node("form", "auth-form");
    const label = node("label", "auth-label", "Email address");
    const field = node("input", "auth-input");
    const submit = button("auth-primary", "Continue");

    label.htmlFor = "auth-email";
    field.id = "auth-email";
    field.name = "email";
    field.type = "email";
    field.autocomplete = "email";
    field.inputMode = "email";
    field.placeholder = "you@example.com";
    field.required = true;
    field.maxLength = 254;
    field.value = email;
    field.spellcheck = false;
    field.setAttribute("autocapitalize", "none");
    form.noValidate = true;
    submit.type = "submit";
    form.append(label, field, submit);
    content.append(googleButton(), divider, form);

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      if (!field.validity.valid || !field.value.trim()) {
        field.setAttribute("aria-invalid", "true");
        showError("Enter a valid email address", true);
        field.focus();
        return;
      }

      email = field.value.trim();
      void run(async (signal) => {
        const next = await post<EmailStep>("email", { email }, signal);

        email = next.email;

        if (next.step === "google") {
          googleAccountView();
        } else {
          passwordView(next.step);
        }
      }, "Continuing…");
    });

    field.addEventListener("input", () => {
      if (authDialog.querySelector(".auth-error.auth-validation"))
        showError("");
      field.removeAttribute("aria-invalid");
    });

    if (authDialog.open) field.focus();
  }

  function emailSummary(): HTMLDivElement {
    const summary = node("div", "auth-email-summary");
    const address = node("span", "", email);
    const edit = button("auth-secondary", "Edit");

    edit.setAttribute("aria-label", "Use a different email");
    edit.addEventListener("click", emailView);
    summary.append(address, edit);
    return summary;
  }

  function passwordView(step: "signup" | "login"): void {
    const signup = step === "signup";
    const content = shell(
      signup ? "Create your password" : "Welcome back",
      signup
        ? "One last step to create your Orbit account"
        : "Enter your password to continue",
    );
    const form = node("form", "auth-form");
    const label = node("label", "auth-label", "Password");
    const wrapper = node("div", "auth-password-wrap");
    const field = node("input", "auth-input");
    const toggle = button("auth-password-toggle", "Show");
    const submit = button("auth-primary", signup ? "Create account" : "Log in");
    const back = button("auth-secondary auth-back", "Use a different email");

    label.htmlFor = "auth-password";
    field.id = "auth-password";
    field.name = "password";
    field.type = "password";
    field.autocomplete = signup ? "new-password" : "current-password";
    field.placeholder = signup ? "Create a password" : "Enter your password";
    field.minLength = 6;
    field.required = true;
    form.noValidate = true;
    toggle.setAttribute("aria-label", "Show password");
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", () => {
      const visible = field.type === "password";

      field.type = visible ? "text" : "password";
      toggle.textContent = visible ? "Hide" : "Show";
      toggle.setAttribute(
        "aria-label",
        visible ? "Hide password" : "Show password",
      );
      toggle.setAttribute("aria-pressed", String(visible));
      field.focus();
    });
    submit.type = "submit";
    wrapper.append(field, toggle);
    form.append(label, wrapper, submit);
    back.addEventListener("click", emailView);
    content.append(emailSummary(), form, back);

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      if (field.value.length < 6 || field.value.length > 128) {
        field.setAttribute("aria-invalid", "true");
        showError(
          field.value.length < 6
            ? "Use at least 6 characters"
            : "Use no more than 128 characters",
          true,
        );
        field.focus();
        return;
      }

      void run(
        async (signal) => {
          const result = await post<{ user: OrbitUser }>(
            step,
            { email, password: field.value },
            signal,
          );

          field.value = "";
          setUser(result.user, { source: step, isNewAccount: signup });
          accountView(true);
        },
        signup ? "Creating account…" : "Logging in…",
      );
    });

    field.addEventListener("input", () => {
      if (authDialog.querySelector(".auth-error.auth-validation"))
        showError("");
      field.removeAttribute("aria-invalid");
    });

    field.focus();
  }

  function googleAccountView(): void {
    const content = shell(
      "Continue with Google",
      "This email uses Google to sign in",
    );
    const back = button("auth-secondary auth-back", "Use a different email");

    back.addEventListener("click", emailView);
    content.append(emailSummary(), googleButton(), back);
    content.querySelector<HTMLButtonElement>(".auth-google-button")?.focus();
  }

  function accountView(fresh = false): void {
    if (!user) {
      emailView();
      return;
    }

    const content = shell(
      fresh ? "You’re signed in" : "Your Orbit account",
      "Your account for this Orbit installation",
    );
    const account = node("div", "auth-account");
    const avatar = node(
      "div",
      "auth-account-avatar",
      user.email.trim().slice(0, 1).toUpperCase(),
    );
    const details = node("div");
    const name = node("strong", "", user.name || user.email.split("@")[0]);
    const address = node("p", "", user.email);
    const method = node(
      "small",
      "",
      user.provider === "google"
        ? "Signed in with Google"
        : "Signed in with email",
    );
    const done = button("auth-primary", "Back to Orbit");
    const logout = button("auth-secondary auth-back", "Sign out");

    avatar.setAttribute("aria-hidden", "true");
    details.append(name, address, method);
    account.append(avatar, details);
    done.addEventListener("click", () => authDialog.close());
    logout.addEventListener("click", () => {
      void signOut().catch((error) =>
        showError(
          error instanceof Error
            ? error.message
            : "Could not sign out. Please try again.",
        ),
      );
    });
    content.append(account, done, logout);
  }

  async function refreshSession(signal?: AbortSignal): Promise<AuthSession> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12000);
    const cancel = () => abort.abort();

    if (signal?.aborted) abort.abort();
    else signal?.addEventListener("abort", cancel, { once: true });

    try {
      const response = await fetch("/api/auth/session", {
        credentials: "same-origin",
        signal: abort.signal,
      });

      if (!response.ok)
        throw new Error(
          "Could not reach the account server. Keep npm start running, then try again.",
        );

      const session = (await response.json()) as AuthSession;

      return { user: session.user || null };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }

  function open(): void {
    if (signingOut) return;
    if (user) accountView();
    else emailView();

    if (!authDialog.open) authDialog.showModal();

    authDialog.querySelector<HTMLInputElement>("input")?.focus();

    void run(async (signal) => {
      await ready;

      if (signal.aborted) return;

      const before = user?.id;
      const session = await refreshSession(signal);

      setUser(
        session.user,
        session.user?.id !== before
          ? { source: "initial", isNewAccount: false }
          : undefined,
      );

      if (session.user && session.user.id !== before) accountView();
      else if (!session.user && before) emailView();
    });
  }

  function close(): void {
    if (authDialog.open) authDialog.close();
  }

  function signOut(): Promise<void> {
    if (signingOut) return signingOut;

    const operation = (async () => {
      await ready;

      if (busy)
        throw new Error(
          "Finish the current sign-in request before signing out.",
        );

      const request = new AbortController();

      controller = request;
      showError("");
      setBusy(true, "Signing out…");

      try {
        await settings.beforeSignOut?.();
        await post("logout", {}, request.signal);
        email = "";
        setUser(null, { source: "logout", isNewAccount: false });

        if (authDialog.open) emailView();
      } catch (error) {
        window.dispatchEvent(new CustomEvent("orbit:authsignouterror"));
        throw error;
      } finally {
        controller = null;
        setBusy(false);
      }
    })();

    signingOut = operation.finally(() => {
      signingOut = null;
    });
    return signingOut;
  }

  authButton.addEventListener("click", open);
  authDialog.addEventListener("close", () => {
    if (!signingOut) {
      generation += 1;
      controller?.abort();
      controller = null;
      busy = false;
    }

    for (const password of authDialog.querySelectorAll<HTMLInputElement>(
      'input[name="password"]',
    ))
      password.value = "";

    authDialog.removeAttribute("aria-busy");
  });

  // OAuth return status

  const returnUrl = new URL(window.location.href);
  const authResult = returnUrl.searchParams.get("auth");
  const authError = returnUrl.searchParams.get("auth_error");
  const newAccount = returnUrl.searchParams.get("new_account") === "1";

  if (authResult || authError || returnUrl.searchParams.has("new_account")) {
    returnUrl.searchParams.delete("auth");
    returnUrl.searchParams.delete("auth_error");
    returnUrl.searchParams.delete("new_account");
    window.history.replaceState(
      null,
      "",
      `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`,
    );
  }

  setUser(null);

  const ready = refreshSession()
    .then((session) => {
      const oauth = authResult === "success" && Boolean(session.user);

      setUser(session.user, {
        source: oauth ? "oauth" : "initial",
        isNewAccount: oauth && newAccount,
      });

      if (oauth && settings.showAccountAfterOAuth !== false) {
        accountView(true);
        if (!authDialog.open) authDialog.showModal();
      } else if (authError) {
        const errors: Record<string, string> = {
          cancelled:
            "Google sign-in was cancelled. You can try again or continue with email.",
          invalid_state: "This sign-in request expired. Please start again.",
          google_failed: "Google sign-in could not finish. Please try again.",
          account_exists:
            "This email already has an Orbit password. Continue with email and your password.",
          google_not_configured: googleUnavailableMessage,
        };

        emailView();
        authDialog.showModal();
        showError(
          errors[authError] ||
            "Google sign-in could not finish. Please try again.",
        );
        authDialog.querySelector<HTMLInputElement>("input")?.focus();
      }
      return user;
    })
    .catch(() => {
      setUser(null, { source: "initial", isNewAccount: false });
      if (authResult || authError) {
        emailView();
        authDialog.showModal();
        showError(
          "Could not reach the account server. Keep npm start running, then try again.",
        );
      }
      return null;
    });

  const api: AuthController = {
    ready,
    getUser: () => user,
    open,
    close,
    signOut,
  };

  authControllers.set(authDialog, {
    controller: api,
    configure: (next) => {
      settings = { ...settings, ...next };
    },
  });
  return api;
}
