import { createProductDemoMotion, productDemoMarkup } from "./intro-demo.js";

type IntroOptions = { onGetStarted: () => void };
type DemoView = "chat" | "companion" | "memory" | "models";

const mounted = new WeakSet<HTMLElement>();

const providers = [
  { id: "openai", name: "OpenAI", tint: "#e8eee9" },
  { id: "claude", name: "Claude", tint: "#fae5d7" },
  { id: "gemini", name: "Gemini", tint: "#e7e6fb" },
  { id: "deepseek", name: "DeepSeek", tint: "#dcecfb" },
  { id: "grok", name: "Grok", tint: "#f7e5ef" },
  { id: "perplexity", name: "Perplexity", tint: "#e4f1ec" },
];

// Code-native illustrations

function glyph(
  name:
    | "arrow"
    | "play"
    | "spark"
    | "window"
    | "memory"
    | "plus"
    | "check"
    | "send",
): string {
  const paths = {
    arrow: "M5 12h14m-6-6 6 6-6 6",
    play: "m9 5 11 7-11 7V5Z",
    spark: "m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8L12 2Z",
    window: "M3 5h18v14H3V5Zm0 5h18M7 7.5h.01M10 7.5h.01",
    memory: "M6 3h12v18H6V3Zm3 5h6M9 12h6M9 16h4",
    plus: "M12 5v14M5 12h14",
    check: "m5 12 4 4L19 6",
    send: "M12 20V4m-6 6 6-6 6 6",
  };

  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}" /></svg>`;
}

function providerIcon(id: string, extraClass = ""): string {
  return `<img class="intro-provider-icon intro-provider-${id} ${extraClass}" src="/assets/icons/${id}.svg" alt="" loading="lazy" />`;
}

function cat(extraClass = ""): string {
  return `<img class="intro-cat ${extraClass}" src="/assets/orbit-cat.svg" alt="" />`;
}

function startButton(extraClass = "", white = false): string {
  return `<button class="intro-button ${white ? "intro-button-light" : "intro-button-dark"} ${extraClass}" type="button" data-get-started>${glyph("arrow")}<span>Get Started</span></button>`;
}

function miniScreen(view: DemoView = "chat", simple = false): string {
  const sideItems = [
    "A new perspective",
    "Ideas worth keeping",
    "A little clarity",
  ];
  const rail = providers
    .map(
      (provider) =>
        `<span class="${provider.id === "openai" ? "is-current" : ""}">${providerIcon(provider.id)}</span>`,
    )
    .join("");
  let content = "";

  if (view === "chat") {
    content = `<div class="intro-mini-welcome">${cat()}<strong>Hi, there <span>✦</span></strong><small>A little space for your next idea.</small><div class="intro-mini-suggestions"><span>Think it through</span><span>Make it clearer</span><span>Start something</span></div></div>`;
  } else if (view === "companion") {
    content = `<div class="intro-mini-article"><span class="intro-mini-document-kicker">A WINDOW INTO YOUR WORK</span><strong>Keep your focus.<br />Bring your AI closer.</strong><div class="intro-mini-copy-lines"><i></i><i></i><i></i><i></i></div><div class="intro-mini-article-grid"><span></span><span></span></div></div><div class="intro-mini-companion">${cat()}<div>Can you help me understand this? ${glyph("send")}</div></div>`;
  } else if (view === "memory") {
    content = `<div class="intro-mini-memory"><small>YOUR WORKSPACE</small><strong>Orbit Memory</strong><p>The details you choose to keep.</p>${["Project direction", "Writing preferences", "Research notes"].map((title, index) => `<div>${glyph("memory")}<span>${title}<i>${["One clear direction", "A voice that feels like you", "Keep the useful parts"][index]}</i></span><b>×</b></div>`).join("")}</div>`;
  } else {
    content = `<div class="intro-mini-models"><strong>Your AI workspace</strong><p>One familiar place.</p>${providers.map((provider) => `<div>${providerIcon(provider.id)}<span>${provider.name}</span><small>${provider.id === "openai" ? "Available" : "Coming soon"}</small></div>`).join("")}</div>`;
  }

  return `<div class="intro-mini-app${simple ? " is-simple" : ""}"><aside class="intro-mini-rail">${cat()}${rail}</aside><aside class="intro-mini-sidebar"><b>Chat</b><span class="intro-mini-new">＋ New Chat</span><small>Saved</small><i>Something to come back to</i><small>Recents</small>${sideItems.map((title) => `<i>${title}</i>`).join("")}<span class="intro-mini-memory-link">${glyph("memory")} Orbit Memory</span></aside><div class="intro-mini-top"><span>Orbit <i>/</i> ChatGPT</span><span class="intro-mini-top-actions"><i></i><i></i><i></i></span></div><div class="intro-mini-content" data-intro-screen-content>${content}</div><div class="intro-mini-composer"><span>✧ Ask anything</span><div><small>GPT-6.1 Sol⌄</small><i>⌕</i><b>${glyph("send")}</b></div></div></div>`;
}

function productScreen(view: DemoView): string {
  return view === "companion" || view === "chat"
    ? productDemoMarkup(view)
    : miniScreen(view);
}

function computer(
  extraClass = "",
  view: DemoView = "chat",
  animated = false,
): string {
  return `<div class="intro-computer ${extraClass}" aria-hidden="true"><div class="intro-computer-lid"><span class="intro-computer-camera"></span><div class="intro-computer-screen">${animated ? productScreen(view) : miniScreen(view)}</div></div><div class="intro-computer-base"><span></span></div><div class="intro-computer-shadow"></div></div>`;
}

function orbitCircle(): string {
  return `<div class="intro-orbit-entrance"><div class="intro-orbit"><div class="intro-orbit-ring">${Array.from(
    { length: 12 },
    (_, index) => {
      const provider = providers[index % providers.length];

      return `<span class="intro-orbit-node" style="--intro-angle:${index * 30}deg;--intro-node-color:${provider.tint}">${providerIcon(provider.id)}</span>`;
    },
  ).join(
    "",
  )}</div><span class="intro-orbit-center">${cat()}</span></div></div>`;
}

function appCardVisual(): string {
  return `<div class="intro-route-card intro-route-card-one">${providerIcon("openai")}<span>A fresh conversation</span>${glyph("arrow")}</div><div class="intro-route-card intro-route-card-two">${glyph("memory")}<span>A thought to keep</span>${glyph("arrow")}</div><div class="intro-route-card intro-route-card-three">${glyph("window")}<span>A window in focus</span>${glyph("arrow")}</div>`;
}

function contextVisual(): string {
  return `<div class="intro-context-window"><span><i></i><i></i><i></i></span><b>A little more context</b><em></em><em></em><em></em></div><div class="intro-context-reply">${cat()}<span>Right here with you.</span></div>`;
}

function modelVisual(): string {
  return `<div class="intro-model-cloud">${providers.map((provider, index) => `<span style="--intro-model-delay:${index * -0.6}s">${providerIcon(provider.id)}</span>`).join("")}</div><span class="intro-model-caption">OpenAI now. More on the way.</span>`;
}

const demoViews: Record<DemoView, { title: string; description: string }> = {
  chat: {
    title: "Ask from your window.<br />Hear back from your AI.",
    description:
      "Type a message in your companion. Orbit sends it to your selected AI and brings the reply into your chat.",
  },
  companion: {
    title: "Stay in your window.<br />Keep Orbit close.",
    description:
      "Drag Orbit onto a window. It snaps into place and brings the current tab’s context into your conversation.",
  },
  memory: {
    title: "Different AIs.<br />Shared memory.",
    description:
      "Orbit shares your saved memories with every connected AI, so you don’t have to repeat yourself. Review or delete them anytime.",
  },
  models: {
    title: "One home.<br />More possibilities.",
    description:
      "Chat with OpenAI today. Gemini, Claude, DeepSeek, Grok, and Perplexity are coming to Orbit in future releases.",
  },
};

// Landing composition

export function initIntro({ onGetStarted }: IntroOptions): void {
  const target = document.getElementById("intro-page");

  if (!target || mounted.has(target)) return;

  const page = target;

  mounted.add(page);
  page.innerHTML = `
    <header class="intro-header" id="intro-header">
      <div class="intro-nav">
        <a class="intro-wordmark" href="#intro-top" data-intro-target="intro-top" aria-label="Orbit home">${cat()}<span>Orbit</span></a>
        <nav class="intro-nav-pill" aria-label="Explore Orbit">
          <a href="#intro-demo" data-intro-target="intro-demo">Product</a>
          <a href="#intro-features" data-intro-target="intro-features">Companion</a>
          <a href="#intro-models" data-intro-target="intro-models">Models</a>
          <a href="#intro-faq" data-intro-target="intro-faq">Help</a>
        </nav>
        ${startButton("intro-nav-start")}
      </div>
    </header>

    <section class="intro-hero intro-motion-scene intro-parallax-stage" id="intro-top" aria-labelledby="intro-hero-title">
      <div class="intro-hero-center">
        <span class="intro-hero-label">${cat()} Orbit</span>
        ${orbitCircle()}
        <h1 id="intro-hero-title" class="intro-hero-title">Your AI.<br />In your orbit.</h1>
        <p class="intro-hero-description">A quieter place for your questions, your context,<br class="intro-desktop-break" /> and whatever comes next.</p>
        <div class="intro-hero-actions">${startButton()}<button class="intro-button intro-button-quiet" type="button" data-intro-target="intro-demo">${glyph("play")}<span>Watch it work</span></button></div>
      </div>
      <div class="intro-float-position intro-float-left" data-intro-parallax="0.06"><div class="intro-float-card intro-float-white">${providerIcon("openai")}<small>YOUR WORKSPACE</small><strong>One clear<br />place.</strong></div></div>
      <div class="intro-float-position intro-float-right" data-intro-parallax="-0.05"><div class="intro-float-card intro-float-mint">${cat()}<small>READY WHEN YOU ARE</small><strong>OpenAI<br /><span>Available now</span></strong></div></div>
      <div class="intro-float-position intro-float-bottom" data-intro-parallax="0.1"><div class="intro-float-card intro-float-blue">${glyph("memory")}<small>A LITTLE CONTEXT</small><strong>Keep the<br />good parts.</strong></div></div>
    </section>

    <section class="intro-demo intro-motion-scene" id="intro-demo" aria-labelledby="intro-demo-title">
      <div class="intro-demo-device intro-reveal" id="intro-demo-panel" role="tabpanel" aria-labelledby="intro-demo-tab-companion" aria-describedby="intro-demo-description">${computer("intro-computer-demo", "companion", true)}</div>
      <div class="intro-demo-copy intro-reveal"><h2 id="intro-demo-title">${demoViews.companion.title}</h2><p id="intro-demo-description">${demoViews.companion.description}</p></div>
      <div class="intro-demo-tabs" role="tablist" aria-label="Explore Orbit features">
        <button class="is-selected" id="intro-demo-tab-companion" aria-controls="intro-demo-panel" type="button" role="tab" aria-selected="true" data-intro-view="companion">${glyph("window")} Companion</button>
        <button id="intro-demo-tab-chat" aria-controls="intro-demo-panel" type="button" role="tab" aria-selected="false" data-intro-view="chat">${glyph("spark")} Chat</button>
        <button id="intro-demo-tab-memory" aria-controls="intro-demo-panel" type="button" role="tab" aria-selected="false" data-intro-view="memory">${glyph("memory")} Memory</button>
        <button id="intro-demo-tab-models" aria-controls="intro-demo-panel" type="button" role="tab" aria-selected="false" data-intro-view="models">${glyph("plus")} Models</button>
      </div>
    </section>

    <section class="intro-features intro-motion-scene intro-parallax-stage" id="intro-features" aria-label="A closer look at Orbit">
      <article class="intro-feature-card intro-reveal" data-intro-parallax="0.02"><div class="intro-feature-visual intro-feature-routes">${appCardVisual()}</div><h3>Your ideas, your way.</h3><p>Start a chat, save a thought, or return to an idea. Keep your everyday conversations together.</p></article>
      <article class="intro-feature-card intro-reveal" data-intro-parallax="0.05"><div class="intro-feature-visual intro-feature-context">${contextVisual()}</div><h3>A little closer to work.</h3><p>A Windows companion for the window in front of you. Your context can come along with the conversation.</p></article>
      <article class="intro-feature-card intro-reveal" data-intro-parallax="0.08"><div class="intro-feature-visual intro-feature-models">${modelVisual()}</div><h3>One familiar home.</h3><p>OpenAI is available today. More familiar AI providers are on the way, all in one Orbit workspace.</p></article>
    </section>

    <section class="intro-manifesto intro-motion-scene" aria-labelledby="intro-manifesto-title">
      <h2 id="intro-manifesto-title" class="intro-reveal">The little ${cat("intro-inline-cat")} companion<br />that stays in your orbit—<br />clearer ${glyph("spark")} thoughts, closer<br />context ${glyph("window")}, less switching.</h2>
      <div class="intro-reveal">${startButton()}</div>
    </section>

    <section class="intro-depth-section intro-dark-zone intro-motion-scene" aria-label="Built around your work">
      <div class="intro-sticky-stack">
        <article class="intro-depth-card intro-depth-first">
          <div class="intro-depth-copy"><span>SPACE TO THINK</span><h2>Turn scattered thoughts<br />into a clearer next step.</h2><p>Ask, explore, refine. OpenAI conversations live in one place, so you can spend more time on the thought in front of you.</p></div>
          <div class="intro-thought-bars" aria-hidden="true"><span>Explore an idea</span><span>Make a plan</span><span>Find the words</span><span>Keep moving</span></div>
        </article>
        <article class="intro-depth-card intro-depth-second">
          <div class="intro-depth-copy"><span>RIGHT WHERE YOU WORK</span><h2>More than a tab.<br />A little presence.</h2><p>Bring the Windows companion beside your active window. Add the browser connection when you want to share a tab’s text.</p></div>
          <div class="intro-depth-companion" aria-hidden="true"><div class="intro-glass-window"><div><i></i><i></i><i></i></div><span>In your window.</span><strong>In your flow.</strong><em></em><em></em></div><span class="intro-depth-cat">${cat()}</span><div class="intro-depth-input">Ask about this window ${glyph("send")}</div></div>
        </article>
        <article class="intro-depth-card intro-depth-third">
          <div class="intro-depth-copy"><span>THE PARTS WORTH KEEPING</span><h2>A familiar thread.<br />From one day to the next.</h2><p>Save useful notes in Orbit Memory. Keep what helps, review what’s there, and remove what you no longer need.</p></div>
          <div class="intro-memory-orbit" aria-hidden="true"><span>${glyph("memory")}</span><span>${cat()}</span><span>${glyph("window")}</span><span>${glyph("spark")}</span></div>
        </article>
      </div>

      <div class="intro-double-scene intro-parallax-stage">
        <span class="intro-giant-word" aria-hidden="true">ORBIT</span>
        <div class="intro-double-devices intro-reveal"><div class="intro-double-back">${computer("intro-computer-dark", "memory")}</div><div class="intro-double-front">${computer("", "chat")}</div></div>
        <div class="intro-dark-invitation intro-reveal"><h2>Get a little<br />closer to Orbit.</h2>${startButton("", true)}</div>
      </div>
    </section>

    <section class="intro-model-statement intro-motion-scene" id="intro-models" aria-labelledby="intro-model-statement-title">
      <h2 id="intro-model-statement-title" class="intro-reveal">Built to bring ${glyph("window")} your tools,<br />your ${cat("intro-inline-cat")} context, and<br />your ideas together.</h2>
      <div class="intro-reveal">${startButton()}</div>
      <p class="intro-release-note intro-reveal">OpenAI is available now. More AI providers are coming soon.</p>
    </section>

    <section class="intro-faq intro-motion-scene" id="intro-faq" aria-labelledby="intro-faq-title">
      <h2 class="intro-reveal" id="intro-faq-title">FAQs</h2>
      <div class="intro-faq-list intro-reveal">
        <details name="orbit-intro-faq"><summary>What is Orbit?<span aria-hidden="true">＋</span></summary><p>Orbit is a workspace for your AI conversations, with memory you can manage and a small Windows companion that stays close to your work.</p></details>
        <details name="orbit-intro-faq"><summary>Which AI can I use today?<span aria-hidden="true">＋</span></summary><p>OpenAI is available in Orbit today. Gemini, Claude, DeepSeek, Grok, and Perplexity are planned for future releases.</p></details>
        <details name="orbit-intro-faq"><summary>How does the companion work?<span aria-hidden="true">＋</span></summary><p>The Windows companion sits beside your active window. With the Orbit browser connection enabled, it can bring the active tab’s text into your conversation.</p></details>
        <details name="orbit-intro-faq"><summary>Can I manage what Orbit remembers?<span aria-hidden="true">＋</span></summary><p>Yes. Open Orbit Memory to review your saved notes. You can choose whether to include those notes in a request and delete what you no longer want to keep.</p></details>
        <details name="orbit-intro-faq"><summary>Where do I start?<span aria-hidden="true">＋</span></summary><p>Choose Get Started to open your Orbit workspace. You can sign in, start a conversation, and find the companion from there.</p></details>
      </div>
    </section>

    <section class="intro-workflows intro-motion-scene" aria-labelledby="intro-workflows-title">
      <h2 id="intro-workflows-title">YOUR WORKFLOW</h2>
      <div class="intro-workflow-cloud">
        <article class="intro-workflow-position intro-workflow-one intro-reveal"><div class="intro-workflow-card"><span>${glyph("spark")}</span><p>Give an idea<br />somewhere to grow.</p><small>THINK IT THROUGH</small><strong>Planning</strong></div></article>
        <article class="intro-workflow-position intro-workflow-two intro-reveal"><div class="intro-workflow-card"><span>${glyph("window")}</span><p>Keep the page.<br />Ask the question.</p><small>STAY WITH YOUR CONTEXT</small><strong>Reading</strong></div></article>
        <article class="intro-workflow-position intro-workflow-three intro-reveal"><div class="intro-workflow-card"><span>${glyph("memory")}</span><p>A useful detail,<br />kept for later.</p><small>KEEP THE THREAD</small><strong>Memory</strong></div></article>
        <article class="intro-workflow-position intro-workflow-four intro-reveal"><div class="intro-workflow-card"><span>${providerIcon("openai")}</span><p>Find the words<br />that feel like you.</p><small>MAKE IT CLEARER</small><strong>Writing</strong></div></article>
        <article class="intro-workflow-position intro-workflow-five intro-reveal"><div class="intro-workflow-card"><span>${cat()}</span><p>A little company.<br />A clearer next step.</p><small>ONE THING AT A TIME</small><strong>Focus</strong></div></article>
      </div>
    </section>

    <section class="intro-last-section intro-motion-scene" aria-labelledby="intro-last-title">
      <div class="intro-last-card intro-reveal"><div class="intro-last-device">${computer("", "companion")}</div><div class="intro-last-copy"><h2 id="intro-last-title">Think clearer.<br />Stay in orbit.</h2><p>A little space for your ideas.<br />A little company for your work.</p>${startButton("", true)}</div></div>
      <footer class="intro-footer"><span>© ${new Date().getFullYear()} Orbit</span><div><a href="#intro-features" data-intro-target="intro-features">Product</a><a href="#intro-models" data-intro-target="intro-models">AI availability</a><a href="#intro-faq" data-intro-target="intro-faq">Help</a></div></footer>
    </section>
  `;

  const header = page.querySelector<HTMLElement>(".intro-header")!;
  const darkZone = page.querySelector<HTMLElement>(".intro-dark-zone")!;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const screenAnimations = new Set<Animation>();
  let frame: number | null = null;
  let demoOnScreen = false;

  function visible(): boolean {
    return !page.hidden && !document.hidden;
  }

  function updateScroll(): void {
    frame = null;

    if (!visible()) return;

    const root = page.getBoundingClientRect();
    const dark = darkZone.getBoundingClientRect();

    header.classList.toggle(
      "intro-header-dark",
      dark.top <= root.top + 60 && dark.bottom > root.top + 60,
    );

    if (reducedMotion.matches) return;

    for (const item of page.querySelectorAll<HTMLElement>(
      "[data-intro-parallax]",
    )) {
      const stage =
        item.closest<HTMLElement>(".intro-parallax-stage") ||
        item.parentElement!;
      const bounds = stage.getBoundingClientRect();
      const distance =
        root.top + page.clientHeight / 2 - (bounds.top + bounds.height / 2);
      const shift = Math.max(
        -55,
        Math.min(55, distance * Number(item.dataset.introParallax || 0)),
      );

      item.style.setProperty("--intro-parallax-y", `${shift.toFixed(2)}px`);
    }
  }

  function scheduleScroll(): void {
    if (frame === null && visible())
      frame = requestAnimationFrame(updateScroll);
  }

  function updateVisibility(): void {
    const paused = !visible();

    page.classList.toggle("intro-is-paused", paused);
    productMotion.setActive(!paused && demoOnScreen);

    for (const animation of screenAnimations) {
      if (paused) animation.pause();
      else animation.play();
    }

    if (paused && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (!paused) {
      page.classList.add("intro-has-opened");
      scheduleScroll();
    }
  }

  for (const control of page.querySelectorAll<HTMLButtonElement>(
    "[data-get-started]",
  )) {
    control.addEventListener("click", (event) => {
      event.stopPropagation();
      onGetStarted();
    });
  }

  for (const control of page.querySelectorAll<HTMLElement>(
    "[data-intro-target]",
  )) {
    control.addEventListener("click", (event) => {
      event.preventDefault();

      const target = page.querySelector<HTMLElement>(
        `#${control.dataset.introTarget}`,
      );

      target?.scrollIntoView({
        behavior: reducedMotion.matches ? "auto" : "smooth",
        block: "start",
      });
    });
  }

  const tabs = [
    ...page.querySelectorAll<HTMLButtonElement>("[data-intro-view]"),
  ];
  const demoScreen = page.querySelector<HTMLElement>(
    ".intro-computer-demo .intro-computer-screen",
  )!;
  const demoTitle = page.querySelector<HTMLElement>("#intro-demo-title")!;
  const demoDescription = page.querySelector<HTMLElement>(
    "#intro-demo-description",
  )!;
  const demoPanel = page.querySelector<HTMLElement>("#intro-demo-panel")!;
  const productMotion = createProductDemoMotion(demoScreen);

  function setDemo(view: DemoView): void {
    demoScreen.innerHTML = productScreen(view);
    productMotion.reset();
    demoTitle.innerHTML = demoViews[view].title;
    demoDescription.textContent = demoViews[view].description;
    demoPanel.setAttribute("aria-labelledby", `intro-demo-tab-${view}`);

    for (const tab of tabs) {
      const selected = tab.dataset.introView === view;

      tab.classList.toggle("is-selected", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }

    if (!reducedMotion.matches && visible()) {
      for (const animation of screenAnimations) animation.cancel();

      screenAnimations.clear();

      const animation = demoScreen.animate(
        [
          { opacity: 0.3, transform: "translateY(5px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 260, easing: "ease-out" },
      );

      screenAnimations.add(animation);
      void animation.finished
        .then(() => screenAnimations.delete(animation))
        .catch(() => screenAnimations.delete(animation));
    }
  }

  tabs.forEach((tab, index) => {
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.addEventListener("click", () =>
      setDemo(tab.dataset.introView as DemoView),
    );
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;

      event.preventDefault();

      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;

      tabs[next].focus();
      setDemo(tabs[next].dataset.introView as DemoView);
    });
  });

  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting)
          entry.target.classList.add("intro-is-visible");
      }
    },
    { root: page, threshold: 0.08 },
  );
  const demoObserver = new IntersectionObserver(
    (entries) => {
      demoOnScreen = entries.some((entry) => entry.isIntersecting);
      productMotion.setActive(visible() && demoOnScreen);
    },
    { root: page, threshold: 0.15 },
  );
  demoObserver.observe(demoPanel);
  const motionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        entry.target.classList.toggle(
          "intro-scene-visible",
          entry.isIntersecting,
        );
    },
    { root: page, threshold: 0 },
  );

  for (const item of page.querySelectorAll(".intro-reveal"))
    revealObserver.observe(item);
  for (const item of page.querySelectorAll(".intro-motion-scene"))
    motionObserver.observe(item);

  page.addEventListener("scroll", scheduleScroll, { passive: true });
  window.addEventListener("resize", scheduleScroll, { passive: true });
  document.addEventListener("visibilitychange", updateVisibility);
  reducedMotion.addEventListener("change", () => {
    for (const item of page.querySelectorAll<HTMLElement>(
      "[data-intro-parallax]",
    ))
      item.style.removeProperty("--intro-parallax-y");
    scheduleScroll();
  });
  new MutationObserver(updateVisibility).observe(page, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  updateVisibility();
}
