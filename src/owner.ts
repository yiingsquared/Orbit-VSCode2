type OwnerStatus = {
  available: boolean;
  openaiConfigured: boolean;
  googleConfigured: boolean;
};

type OwnerOptions = { onSaved?: () => void };

const initialized = new WeakSet<HTMLElement>();

// Local owner connection setup

export function initOwnerSetup({ onSaved }: OwnerOptions = {}): void {
  const target = document.getElementById("owner-setup");

  if (!target || initialized.has(target)) return;

  initialized.add(target);
  target.hidden = true;
  const section = target;
  const busyForms = new WeakSet<HTMLFormElement>();
  let status: OwnerStatus;
  let callbackUrl = new URL("/api/auth/google/callback", window.location.origin)
    .href;

  function node<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text = "",
  ): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);

    if (className) result.className = className;
    if (text) result.textContent = text;

    return result;
  }

  function link(text: string, url: string): HTMLAnchorElement {
    const result = node("a", "", text);

    result.href = url;
    result.target = "_blank";
    result.rel = "noopener noreferrer";
    return result;
  }

  function message(
    form: HTMLFormElement,
    text: string,
    state: "error" | "success" | "pending" | "" = "",
  ): void {
    const output = form.querySelector<HTMLElement>(".owner-message");

    if (!output) return;

    output.textContent = text;
    output.dataset.state = state;
    output.hidden = !text;
    output.setAttribute("role", state === "error" ? "alert" : "status");
  }

  function setBusy(form: HTMLFormElement, busy: boolean): void {
    form.setAttribute("aria-busy", String(busy));

    if (busy) busyForms.add(form);
    else busyForms.delete(form);

    for (const control of form.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input,button")) {
      control.disabled = busy;
    }

    const button = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (button) {
      if (!button.dataset.originalLabel)
        button.dataset.originalLabel = button.textContent || "";
      button.textContent = busy ? "Saving…" : button.dataset.originalLabel;
    }
  }

  function updateStatus(): void {
    const openai = section.querySelector<HTMLElement>(
      '[data-owner-status="openai"]',
    );
    const google = section.querySelector<HTMLElement>(
      '[data-owner-status="google"]',
    );

    if (openai)
      openai.textContent = status.openaiConfigured
        ? "Key configured"
        : "Not connected";
    if (google)
      google.textContent = status.googleConfigured
        ? "Google sign-in configured"
        : "Not connected";
  }

  async function save(
    form: HTMLFormElement,
    payload: Record<string, unknown>,
    clear: () => void,
  ): Promise<void> {
    if (busyForms.has(form)) return;

    message(form, "Saving this server connection…", "pending");
    setBusy(form, true);

    try {
      const response = await fetch("/api/owner/credentials", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", ...payload }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 403 && result.code === "local_only") {
          clearSecrets();
          section.hidden = true;
        }

        throw new Error(
          result.message || "Could not save the connection. Please try again.",
        );
      }

      if (result.status !== "saved" || result.available !== true) {
        throw new Error("The connection was not confirmed. Please try again.");
      }

      status = result as OwnerStatus;
      clear();
      updateStatus();
      message(form, "Connection saved.", "success");

      try {
        await onSaved?.();
      } catch {
        message(
          form,
          "Connection saved. Refresh Orbit to update the available models.",
          "success",
        );
      }
    } catch (error) {
      message(
        form,
        error instanceof Error
          ? error.message
          : "Could not save the connection. Please try again.",
        "error",
      );
    } finally {
      setBusy(form, false);
    }
  }

  function field(
    id: string,
    labelText: string,
    type = "text",
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = node("label", "owner-label", labelText);
    const input = node("input", "owner-input");

    label.htmlFor = id;
    input.id = id;
    input.name = id;
    input.type = type;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "none");
    return { label, input };
  }

  function formWithSubmit(label: string): {
    form: HTMLFormElement;
    actions: HTMLDivElement;
  } {
    const form = node("form", "owner-form");
    const actions = node("div", "owner-actions");
    const submit = node("button", "quiet-button", label);
    const output = node("p", "owner-message");

    form.noValidate = true;
    submit.type = "submit";
    output.hidden = true;
    output.setAttribute("aria-live", "polite");
    actions.append(submit);
    form.append(actions, output);
    return { form, actions };
  }

  function clearSecrets(): void {
    for (const input of section.querySelectorAll<HTMLInputElement>(
      "input:not([readonly])",
    ))
      input.value = "";
  }

  function render(): void {
    section.replaceChildren();

    const title = node("h3", "", "Set up Orbit");
    const description = node(
      "p",
      "owner-help",
      "One-time setup for the website owner. Visitors use the server connection and don’t need to enter their own API key.",
    );
    const location = node(
      "p",
      "owner-help",
      "These controls are available only from this computer’s local Orbit address.",
    );
    const openaiSection = node("div", "owner-section");
    const openaiTitle = node("h4", "", "AI replies");
    const openaiStatus = node("p", "owner-message owner-status");
    const openaiHelp = node(
      "p",
      "owner-help",
      "Connect OpenAI once for this Orbit server.",
    );
    const key = field("owner-openai-key", "OpenAI API key", "password");
    const openai = formWithSubmit("Save server connection");

    openaiStatus.dataset.ownerStatus = "openai";
    key.input.placeholder = "Paste your OpenAI API key";
    key.input.required = true;
    openai.actions.append(
      link("Get an OpenAI API key", "https://platform.openai.com/api-keys"),
    );
    openai.form.prepend(key.label, key.input);
    openai.form.addEventListener("submit", (event) => {
      event.preventDefault();

      const value = key.input.value.trim();

      if (!value) {
        message(
          openai.form,
          "Paste your OpenAI API key before saving.",
          "error",
        );
        key.input.focus();
        return;
      }

      void save(openai.form, { provider: "openai", openaiKey: value }, () => {
        key.input.value = "";
      });
    });
    key.input.addEventListener("input", () => message(openai.form, ""));
    openaiSection.append(openaiTitle, openaiStatus, openaiHelp, openai.form);

    // Google Web client credentials

    const googleSection = node("div", "owner-section");
    const googleTitle = node("h4", "", "Google sign-in");
    const googleStatus = node("p", "owner-message owner-status");
    const googleHelp = node(
      "p",
      "owner-help",
      "Choose the Web application JSON credentials downloaded from Google Cloud. This connects Google sign-in for Orbit.",
    );
    const google = formWithSubmit("Save Google sign-in");
    const upload = field("owner-google-json", "Google OAuth JSON file", "file");
    const callback = field("owner-google-callback", "Authorized redirect URI");
    const callbackHelp = node(
      "p",
      "owner-help",
      "Add this exact redirect URI to the Google OAuth Web application client.",
    );

    googleStatus.dataset.ownerStatus = "google";
    upload.input.accept = "application/json,.json";
    google.form.prepend(upload.label, upload.input);
    google.actions.append(
      link(
        "Get Google OAuth credentials",
        "https://console.cloud.google.com/auth/clients",
      ),
    );
    callback.input.readOnly = true;
    callback.input.value = callbackUrl;
    callback.input.setAttribute("aria-label", "Google authorized redirect URI");
    google.form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (busyForms.has(google.form)) return;

      const file = upload.input.files?.[0];

      if (!file) {
        message(
          google.form,
          "Choose the Google OAuth JSON file first.",
          "error",
        );
        return;
      }

      if (file.size >= 64 * 1024) {
        message(
          google.form,
          "Choose a Google credentials JSON file smaller than 64 KB.",
          "error",
        );
        upload.input.value = "";
        return;
      }

      try {
        const credentials = JSON.parse(await file.text());

        if (
          !credentials ||
          !credentials.web ||
          typeof credentials.web.client_id !== "string" ||
          typeof credentials.web.client_secret !== "string"
        ) {
          throw new Error(
            "Choose the downloaded credentials for a Google OAuth Web application.",
          );
        }

        await save(
          google.form,
          {
            provider: "google",
            googleOAuth: {
              web: {
                client_id: credentials.web.client_id,
                client_secret: credentials.web.client_secret,
              },
            },
          },
          () => {
            upload.input.value = "";
          },
        );
      } catch (error) {
        message(
          google.form,
          error instanceof SyntaxError
            ? "This file is not valid JSON. Choose the downloaded Google credentials file."
            : error instanceof Error
              ? error.message
              : "Could not read the Google credentials file.",
          "error",
        );
      }
    });
    upload.input.addEventListener("change", () => message(google.form, ""));

    // Optional manual fields

    const manual = node("details", "owner-google-fields");
    const summary = node("summary", "", "Enter Google credentials manually");
    const manualForm = formWithSubmit("Save Google credentials");
    const clientId = field("owner-google-client-id", "Google client ID");
    const clientSecret = field(
      "owner-google-client-secret",
      "Google client secret",
      "password",
    );

    clientId.input.placeholder = "Your Web application client ID";
    clientSecret.input.placeholder = "Your Google OAuth client secret";
    manualForm.form.prepend(
      clientId.label,
      clientId.input,
      clientSecret.label,
      clientSecret.input,
    );
    manualForm.form.addEventListener("submit", (event) => {
      event.preventDefault();

      const id = clientId.input.value.trim();
      const secret = clientSecret.input.value.trim();

      if (!id || !secret) {
        message(
          manualForm.form,
          "Enter both the Google client ID and client secret.",
          "error",
        );
        (!id ? clientId.input : clientSecret.input).focus();
        return;
      }

      void save(
        manualForm.form,
        { provider: "google", googleClientId: id, googleClientSecret: secret },
        () => {
          clientId.input.value = "";
          clientSecret.input.value = "";
        },
      );
    });

    for (const input of [clientId.input, clientSecret.input])
      input.addEventListener("input", () => message(manualForm.form, ""));

    manual.append(summary, manualForm.form);
    googleSection.append(
      googleTitle,
      googleStatus,
      googleHelp,
      google.form,
      callback.label,
      callback.input,
      callbackHelp,
      manual,
    );
    section.append(title, description, location, openaiSection, googleSection);
    section.hidden = false;
    section.closest("dialog")?.addEventListener("close", clearSecrets);
    updateStatus();
  }

  // Availability before rendering credentials

  void (async () => {
    const response = await fetch("/api/owner/status", {
      credentials: "same-origin",
    });

    if (!response.ok) return;

    const result = (await response.json()) as OwnerStatus;

    if (result.available !== true) return;

    status = result;

    try {
      const session = await fetch("/api/auth/session", {
        credentials: "same-origin",
      });

      if (session.ok) {
        const auth = await session.json();

        if (typeof auth.googleCallbackUrl === "string") {
          const parsed = new URL(auth.googleCallbackUrl);

          if (parsed.origin === window.location.origin)
            callbackUrl = parsed.href;
        }
      }
    } catch {}

    render();
  })().catch(() => {
    section.hidden = true;
    section.replaceChildren();
  });
}
