const form = document.getElementById("pair-form");
const connected = document.getElementById("connected");
const error = document.getElementById("error");
const pause = document.getElementById("pause-button");
let paused = false;

// Popup messaging

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);

  if (!result?.ok)
    throw new Error(result?.message || "Could not connect to Orbit.");

  return result;
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

async function refresh() {
  try {
    const state = await send({ type: "orbit:status" });

    form.hidden = state.paired;
    connected.hidden = !state.paired;
    paused = state.paused;
    pause.textContent = paused ? "Resume reading" : "Pause reading";
    document.getElementById("connection-status").textContent = state.online
      ? state.serverPaused
        ? "Reading paused in Orbit"
        : paused
          ? "Reading paused"
          : "Connected to Orbit"
      : "Open Orbit to reconnect";
    document
      .getElementById("status-dot")
      .classList.toggle(
        "online",
        state.online && !paused && !state.serverPaused,
      );
  } catch (problem) {
    showError(problem.message);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const submit = form.querySelector("button");

  submit.disabled = true;
  showError("");

  try {
    await send({
      type: "orbit:pair",
      code: document.getElementById("pair-code").value,
    });
    document.getElementById("pair-code").value = "";
    await refresh();
  } catch (problem) {
    showError(problem.message);
  } finally {
    submit.disabled = false;
  }
});

pause.addEventListener("click", async () => {
  try {
    await send({ type: "orbit:pause", paused: !paused });
    await refresh();
  } catch (problem) {
    showError(problem.message);
  }
});

document
  .getElementById("disconnect-button")
  .addEventListener("click", async () => {
    try {
      await send({ type: "orbit:disconnect" });
      await refresh();
    } catch (problem) {
      showError(problem.message);
    }
  });

document
  .getElementById("pair-code")
  .addEventListener("input", () => showError(""));
void refresh();
