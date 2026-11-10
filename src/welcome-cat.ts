const svgNamespace = "http://www.w3.org/2000/svg";

// Seven-second expressions

export function initWelcomeCat(): () => void {
  const host = document.getElementById("welcome-cat");

  if (!host) return () => {};

  const svg = document.createElementNS(svgNamespace, "svg");
  const body = document.createElementNS(svgNamespace, "path");
  const face = document.createElementNS(svgNamespace, "g");

  svg.setAttribute("viewBox", "0 0 64 56");
  svg.setAttribute("aria-hidden", "true");
  body.setAttribute(
    "d",
    "M10 17C7 11 7 5 11 5c4-1 6 5 10 5a54 54 0 0 1 23 0c4-1 6-6 10-5 4 0 4 7 1 13 5 8 7 14 6 20-1 12-12 17-29 17S3 50 3 38c-1-7 2-14 7-21Z",
  );
  body.setAttribute("fill", "#ff414d");
  body.setAttribute("stroke", "none");
  face.setAttribute("fill", "none");
  face.setAttribute("stroke", "#fff");
  face.setAttribute("stroke-width", "4.5");
  face.setAttribute("stroke-linecap", "round");
  face.setAttribute("stroke-linejoin", "round");
  svg.append(body, face);
  host.replaceChildren(svg);

  const expressions = [
    ["M26 28v8", "M38 28v8"],
    ["M22 33q4-8 8 0", "M34 33q4-8 8 0", "M29 41q3 3 6 0"],
    ["M23 32h7", "M38 28v8", "M29 41q3 2 6 0"],
    ["M23 30l6 3-6 3", "M41 30l-6 3 6 3"],
    ["M26 27v5", "M38 27v5", "M30 40q2-4 4 0q-2 4-4 0"],
  ];
  let expression = 0;
  let changes = 0;
  let animation: Animation | undefined;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function draw(): void {
    face.replaceChildren();

    for (const data of expressions[expression]) {
      const path = document.createElementNS(svgNamespace, "path");

      path.setAttribute("d", data);
      face.append(path);
    }

    host!.dataset.expression = String(expression);
    host!.dataset.expressionSequence = String(changes);
  }

  function change(): void {
    if (document.visibilityState !== "visible" || host!.offsetParent === null)
      return;

    const next =
      (expression + 1 + Math.floor(Math.random() * (expressions.length - 1))) %
      expressions.length;

    expression = next;
    changes += 1;
    draw();

    if (!reducedMotion.matches) {
      animation?.cancel();
      animation = svg.animate(
        [
          { transform: "translateY(0) scale(1)" },
          { transform: "translateY(-3px) scale(1.04, .96)", offset: 0.4 },
          { transform: "translateY(0) scale(1)" },
        ],
        { duration: 480, easing: "cubic-bezier(.2,.8,.3,1)" },
      );
    }
  }

  draw();
  const timer = window.setInterval(change, 7000);

  return () => {
    window.clearInterval(timer);
    animation?.cancel();
  };
}
