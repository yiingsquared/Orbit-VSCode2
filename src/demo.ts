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
  const gradient = document.getElementById("demo-launch-gradient");

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
      ? 3.7
      : ((time - started) / 1000) % 9;
    const dock = smooth((progress - 3.1) / 0.45);
    const opening = smooth((progress - 4) / 0.55);
    const closing = smooth((progress - 7.2) / 0.5);
    const expanded = opening * (1 - closing);
    let centerX = 300;
    let centerY = 15;
    const between = (
      a: number,
      b: number,
      start: number,
      duration: number,
    ): number => a + (b - a) * smooth((progress - start) / duration);
    if (progress >= 0.6 && progress < 1.6) {
      centerX = between(300, 275, 0.6, 1);
      centerY = between(15, 117, 0.6, 1);
    } else if (progress < 2.1 && progress >= 1.6) {
      centerX = between(275, 345, 1.6, 0.5);
      centerY = between(117, 130, 1.6, 0.5);
    } else if (progress < 2.4 && progress >= 2.1) {
      centerX = between(345, 315, 2.1, 0.3);
      centerY = between(130, 180, 2.1, 0.3);
    } else if (progress < 3.1 && progress >= 2.4) {
      centerX = between(315, 300, 2.4, 0.7);
      centerY = between(180, 100, 2.4, 0.7);
    } else if (progress >= 3.1) {
      centerX = 300;
      centerY = 100 - dock * 28;
    }
    const x = centerX - 22;
    const y = centerY - 21;
    const squash = 1 - dock * 0.3;

    cat!.setAttribute(
      "transform",
      `translate(${x} ${y}) translate(22 21) scale(${1 + dock * 0.08} ${squash}) translate(-22 -21)`,
    );
    cat!.style.opacity = String(
      smooth((progress - 0.6) / 0.18) * (1 - expanded),
    );
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

    if (progress > 0.65 && progress < 2.28) {
      const dx = centerX - 300;
      const dy = centerY - 15;
      const distance = Math.hypot(dx, dy);
      const nx = -dy / Math.max(1, distance);
      const ny = dx / Math.max(1, distance);
      const mx = 300 + dx * 0.52;
      const my = 15 + dy * 0.52;
      const neck = Math.max(1.3, 4.5 * (1 - distance / 180));
      tether!.setAttribute(
        "d",
        `M${300 + nx * 6} ${15 + ny * 6}Q${mx + nx * neck} ${my + ny * neck} ${centerX + nx * 13} ${centerY + ny * 13}L${centerX - nx * 13} ${centerY - ny * 13}Q${mx - nx * neck} ${my - ny * neck} ${300 - nx * 6} ${15 - ny * 6}Z`,
      );
      gradient?.setAttribute("x2", String(centerX));
      gradient?.setAttribute("y2", String(centerY));
      tether!.style.opacity = "1";
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
