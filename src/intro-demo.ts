type ProductView = "companion" | "chat";

const message = "Summarize this page";
const answer = "Reply ready in Orbit";
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => {
  const n = clamp(value);

  return n * n * (3 - 2 * n);
};
const mix = (from: number, to: number, amount: number): number =>
  from + (to - from) * amount;

// Separate demonstration timelines

export function companionDemoFrame(time: number) {
  const stops = [
    [0.5, 300, 20],
    [1.45, 280, 88],
    [2.1, 337, 116],
    [2.6, 300, 166],
    [3.25, 434, 90],
  ];
  let x = 300;
  let y = 20;

  for (let index = 1; index < stops.length; index++) {
    const previous = stops[index - 1];
    const next = stops[index];

    if (time < previous[0]) break;

    const amount = smooth((time - previous[0]) / (next[0] - previous[0]));

    x = mix(previous[1], next[1], amount);
    y = mix(previous[2], next[2], amount);
  }

  const dock = smooth((time - 3.25) / 0.35);
  const age = Math.max(0, time - 3.25);

  y -= Math.sin(age * 18) * Math.exp(-age * 8) * 4;

  return {
    x,
    y,
    dock,
    scale: 1 - dock * 0.35,
    cat: smooth((time - 0.5) / 0.15),
    tether: time > 0.5 && time < 2.43 ? 1 : 0,
    cursor: time > 0.2 && time < 3.8 ? 1 : 0,
    tilt: time > 0.5 && time < 3.25 ? Math.sin(time * 5) * 6 : 0,
  };
}

export function chatDemoFrame(time: number) {
  return {
    open: smooth((time - 0.35) / 0.45) * (1 - smooth((time - 3.1) / 0.4)),
    draft: message.slice(
      0,
      Math.floor(clamp((time - 1) / 1.65) * message.length),
    ),
    sent: smooth((time - 3.6) / 0.25),
    packet: clamp((time - 3.1) / 0.6),
    loading: time >= 3.8 && time < 4.5,
    reply: answer.slice(
      0,
      Math.floor(clamp((time - 4.5) / 1.15) * answer.length),
    ),
    unread: time >= 6.1,
    enter: time >= 3 && time < 3.25,
  };
}

// Desktop application and independent companion

function mascot(): string {
  return '<image href="/assets/orbit-cat.svg" x="-22" y="-19.25" width="44" height="38.5" />';
}

function pointer(): string {
  return '<path data-product-part="cursor" d="M0 0V21L5 16L10 25L14 23L9 14H18Z" fill="#fff" stroke="#595963" stroke-width="1.2" />';
}

function detailIcon(path: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`;
}

export function productDemoMarkup(view: ProductView): string {
  const noteIcon = detailIcon("M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h4");
  const destination =
    view === "chat"
      ? `<div class="intro-desktop-ai"><img src="/assets/icons/openai.svg" alt="" /><div><strong>ChatGPT <span data-product-part="sent" style="opacity:0">${detailIcon("m5 12 4 4L19 6")}</span></strong><small data-product-part="welcome">Selected AI</small><div class="intro-desktop-ai-response" data-product-part="response" style="opacity:0"><span class="intro-desktop-thinking" data-product-part="loading"><i></i><i></i><i></i></span><small data-product-part="reply"></small></div></div></div>`
      : "";

  return `<div class="intro-desktop-demo" data-product-view="${view}">
    <div class="intro-desktop-shortcuts"><span><i>${detailIcon("M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3")}</i>Files</span><span><i>${noteIcon}</i>Notes</span></div>
    <div class="intro-desktop-window">
      <div class="intro-desktop-titlebar"><span>${noteIcon} Project notes — Notes</span><div class="intro-desktop-window-controls"><i>−</i><i>□</i><i>×</i></div></div>
      <div class="intro-desktop-menubar"><span>File</span><span>Edit</span><span>View</span><i>All changes saved</i></div>
      <article class="intro-desktop-document"><small>PROJECT NOTES</small><h3>Plan your next<br />great idea.</h3><p>A few useful thoughts for your next project.</p><div class="intro-desktop-note-cards"><div><span>✦</span><strong>The big picture</strong><small>Keep the goal in focus</small></div><div><span>↗</span><strong>Next steps</strong><small>Turn ideas into action</small></div></div></article>
    </div>
    ${destination}
    <div class="intro-desktop-taskbar"><div><span class="intro-desktop-start">${detailIcon("M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z")}</span><span>${noteIcon}</span><span class="intro-desktop-taskbar-orbit"><img src="/assets/orbit-cat.svg" alt="" /></span></div><small>9:41 AM</small></div>
    ${productDemoOverlay(view)}
  </div>`;
}

// Window edge at y=100 in desktop coordinates

export function productDemoOverlay(view: ProductView): string {
  const content =
    view === "companion"
      ? `<path d="M272 0C282 0 282 29 291 29H309C318 29 318 0 328 0Z" fill="#1d1c23" />
      <ellipse cx="300" cy="19" rx="8" ry="6" fill="#312d37" /><path d="M297 18V21M303 18V21" stroke="#fff" stroke-width="1.6" stroke-linecap="round" />
      <path data-product-part="tether" fill="url(#intro-product-pull-gradient)" opacity="0" />
      <path data-product-part="notch" d="M397 100C405 100 405 76 414 76H454C463 76 463 100 471 100Z" fill="#1d1c23" opacity="0" />
      <path data-product-part="landing" d="M401 100H467" fill="none" stroke="#ff414d" stroke-width="1.6" stroke-linecap="round" opacity="0" />
      <g data-product-part="cat" opacity="0">${mascot()}</g>`
      : `<path d="M397 100C405 100 405 76 414 76H454C463 76 463 100 471 100Z" fill="#1d1c23" />
      <g data-product-part="cat" transform="translate(434 90) scale(.65)">${mascot()}</g>
      <circle data-product-part="unread" cx="446" cy="78" r="3" fill="#34c759" opacity="0" />
      <g data-product-part="input" opacity="0"><path d="M302 100C310 100 310 69 320 69H512C522 69 522 100 530 100Z" fill="#1d1c23" /><rect x="319" y="76" width="194" height="23" rx="9" fill="#2b2932" /><text data-product-part="draft" x="329" y="92" class="intro-product-draft"></text><path data-product-part="caret" d="M330 81V94" stroke="#fff" stroke-width="1" /><rect data-product-part="enter" x="490" y="79" width="20" height="16" rx="3" fill="#49464f" /><text x="494" y="91" class="intro-product-enter">↵</text></g>
      <rect data-product-part="packet" width="14" height="5" rx="2.5" fill="#ff414d" opacity="0" />`;

  return `<svg class="intro-product-overlay" viewBox="0 0 600 375" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="intro-product-pull-gradient" gradientUnits="userSpaceOnUse" x1="300" y1="20" x2="300" y2="166" data-product-part="gradient"><stop stop-color="#312d37" /><stop offset=".42" stop-color="#6e2a39" /><stop offset="1" stop-color="#ff414d" /></linearGradient></defs>${content}${pointer()}</svg>`;
}

// One animation loop for the visible demo

export function createProductDemoMotion(screen: HTMLElement) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let active = false;
  let frame = 0;
  let elapsed = 0;
  let previous: number | null = null;
  let view: ProductView | null = null;
  let parts = new Map<string, SVGElement | HTMLElement>();

  function attr(name: string, attribute: string, value: string | number): void {
    parts.get(name)?.setAttribute(attribute, String(value));
  }

  function opacity(name: string, value: number): void {
    attr(name, "opacity", value);
    const target = parts.get(name);

    if (target) target.style.opacity = String(value);
  }

  function text(name: string, value: string): void {
    const target = parts.get(name);

    if (target) target.textContent = value;
  }

  function draw(time: number): void {
    if (view === "companion") {
      const state = companionDemoFrame(time);
      const dx = state.x - 300;
      const dy = state.y - 20;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / distance;
      const ny = dx / distance;
      const mx = 300 + dx * 0.52;
      const my = 20 + dy * 0.52;

      attr(
        "cat",
        "transform",
        `translate(${state.x} ${state.y}) rotate(${state.tilt}) scale(${state.scale})`,
      );
      opacity("cat", state.cat);
      opacity("notch", state.dock);
      opacity("landing", smooth((time - 2.65) / 0.35) * (1 - state.dock) * 0.6);
      attr(
        "tether",
        "d",
        `M${300 + nx * 6} ${20 + ny * 6}Q${mx + nx * 2} ${my + ny * 2} ${state.x + nx * 13} ${state.y + ny * 13}L${state.x - nx * 13} ${state.y - ny * 13}Q${mx - nx * 2} ${my - ny * 2} ${300 - nx * 6} ${20 - ny * 6}Z`,
      );
      opacity("tether", state.tether);
      attr("gradient", "x2", state.x);
      attr("gradient", "y2", state.y);
      attr(
        "cursor",
        "transform",
        `translate(${state.x + 13} ${state.y + 11}) scale(.75)`,
      );
      opacity("cursor", state.cursor);
    } else if (view === "chat") {
      const state = chatDemoFrame(time);

      opacity("cat", 1 - state.open);
      opacity("input", state.open);
      attr(
        "input",
        "transform",
        `translate(434 90) scale(${0.4 + state.open * 0.6} 1) translate(-434 -90)`,
      );
      text("draft", state.draft);
      attr("caret", "transform", `translate(${state.draft.length * 6.65} 0)`);
      opacity("caret", time % 0.7 < 0.4 ? 1 : 0);
      attr("enter", "fill", state.enter ? "#ff414d" : "#49464f");
      opacity("welcome", 1 - state.sent);
      opacity("sent", state.sent);
      const bubble = parts.get("sent");

      if (bubble)
        bubble.style.transform = `translateY(${5 * (1 - state.sent)}px)`;
      opacity("response", smooth((time - 3.8) / 0.2));
      opacity("loading", state.loading ? 1 : 0);
      text("reply", state.reply);
      opacity("unread", state.unread ? 1 : 0);
      attr("packet", "x", mix(426, 455, state.packet));
      attr("packet", "y", mix(101, 330, state.packet));
      opacity("packet", Math.sin(state.packet * Math.PI));
      attr("cursor", "transform", "translate(451 102) scale(.65)");
      opacity("cursor", time < 3.35 ? 1 : 0);
    }
  }

  function stop(): void {
    if (frame) cancelAnimationFrame(frame);

    frame = 0;
    previous = null;
  }

  function tick(now: number): void {
    frame = 0;
    if (!active || !view || reduced.matches) return;
    if (previous !== null) elapsed += Math.min(100, now - previous) / 1000;

    previous = now;
    draw(elapsed % (view === "companion" ? 6.2 : 8));
    frame = requestAnimationFrame(tick);
  }

  function start(): void {
    if (active && view && !reduced.matches && !frame)
      frame = requestAnimationFrame(tick);
  }

  function reset(): void {
    stop();
    elapsed = 0;
    const scene = screen.querySelector<HTMLElement>("[data-product-view]");

    view =
      scene?.dataset.productView === "companion" ||
      scene?.dataset.productView === "chat"
        ? scene.dataset.productView
        : null;
    parts = new Map(
      [
        ...screen.querySelectorAll<SVGElement | HTMLElement>(
          "[data-product-part]",
        ),
      ].map((element) => [element.dataset.productPart!, element]),
    );
    if (view) draw(reduced.matches ? (view === "companion" ? 4.2 : 6.6) : 0);

    start();
  }

  function motionChanged(): void {
    reset();
  }

  reduced.addEventListener("change", motionChanged);
  reset();

  return {
    reset,
    setActive(next: boolean): void {
      active = next;
      if (next) start();
      else stop();
    },
    dispose(): void {
      active = false;
      stop();
      reduced.removeEventListener("change", motionChanged);
    },
  };
}
