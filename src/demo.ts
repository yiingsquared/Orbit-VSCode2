// Transparent companion sequence

export function initCompanionDemo(): void {
  const stage = document.getElementById("companion-demo");
  const dialog = document.getElementById(
    "companion-dialog",
  ) as HTMLDialogElement | null;
  const cat = document.getElementById("demo-cat");
  const cursor = document.getElementById("demo-cursor");
  const input = document.getElementById("demo-input");
  const typing = document.getElementById("demo-typing");
  const notch = document.getElementById("demo-notch");
  const tether = document.getElementById("demo-tether");

  if (
    !stage ||
    !dialog ||
    !cat ||
    !cursor ||
    !input ||
    !typing ||
    !notch ||
    !tether
  )
    return;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let started = 0;
  let frame = 0;

  const smooth = (value: number): number => {
    const n = Math.max(0, Math.min(1, value));

    return n * n * (3 - 2 * n);
  };

  function draw(time: number): void {
    const progress = reducedMotion.matches
      ? 3.4
      : ((time - started) / 1000) % 9;
    const drag = smooth((progress - 0.6) / 1.7);
    const dock = smooth((progress - 2.2) / 0.5);
    const opening = smooth((progress - 4) / 0.55);
    const closing = smooth((progress - 7.2) / 0.5);
    const expanded = opening * (1 - closing);
    const x = 42 + drag * 236;
    const y = 142 - Math.sin((drag * Math.PI) / 2) * 91 + dock * 7;
    const squash = 1 - dock * 0.3;

    cat!.setAttribute(
      "transform",
      `translate(${x} ${y}) translate(22 21) scale(${1 + dock * 0.08} ${squash}) translate(-22 -21)`,
    );
    cat!.style.opacity = String(1 - expanded);
    notch!.style.opacity = String(dock);
    cursor!.setAttribute(
      "transform",
      `translate(${x + 30 + expanded * 60} ${y + 28}) scale(.8)`,
    );
    cursor!.style.opacity = progress > 7.9 ? "0" : "1";
    input!.style.opacity = String(expanded);
    input!.setAttribute(
      "transform",
      `translate(300 74) scale(${Math.max(0.18, expanded)} 1) translate(-300 -74)`,
    );
    typing!.style.opacity = progress > 4.8 && progress < 7.3 ? "1" : "0";
    typing!.setAttribute(
      "stroke-dasharray",
      `${Math.max(0, Math.min(90, (progress - 4.8) * 45))} 130`,
    );

    if (progress > 1.6 && progress < 2.4) {
      const width = 3 + (1 - dock) * 3;

      tether!.setAttribute(
        "d",
        `M300 73Q${x + 20} ${y - 5} ${x + 20 - width} ${y + 18}L${x + 24 + width} ${y + 18}Q${x + 24} ${y - 5} 302 73Z`,
      );
      tether!.style.opacity = String((1 - dock) * 0.65);
    } else {
      tether!.style.opacity = "0";
    }
  }

  function tick(time: number): void {
    if (!dialog!.open || document.hidden) {
      frame = 0;
      return;
    }

    draw(time);
    if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
  }

  function update(): void {
    if (frame) cancelAnimationFrame(frame);

    frame = 0;

    if (dialog!.open && !document.hidden) {
      started = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  new MutationObserver(update).observe(dialog, {
    attributes: true,
    attributeFilter: ["open"],
  });
  document.addEventListener("visibilitychange", update);
  reducedMotion.addEventListener("change", update);
}
