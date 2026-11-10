// Text-only DOM construction

function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    fragment.append(text.slice(cursor, match.index));

    const token = match[0];
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);

    if (link) {
      const anchor = document.createElement("a");

      anchor.textContent = link[1];
      anchor.href = link[2];
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      fragment.append(anchor);
    } else {
      const element = document.createElement(
        token.startsWith("`") ? "code" : "strong",
      );
      const trim = token.startsWith("`") ? 1 : 2;

      element.textContent = token.slice(trim, -trim);
      fragment.append(element);
    }

    cursor = (match.index ?? 0) + token.length;
  }

  fragment.append(text.slice(cursor));
  return fragment;
}

export function renderMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let list: HTMLUListElement | HTMLOListElement | null = null;

  function flush(): void {
    if (paragraph.length) {
      const element = document.createElement("p");

      element.append(inline(paragraph.join("\n")));
      fragment.append(element);
      paragraph = [];
    }

    list = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("```")) {
      flush();

      const codeLines: string[] = [];
      const pre = document.createElement("pre");
      const code = document.createElement("code");

      while (++index < lines.length && !lines[index].startsWith("```"))
        codeLines.push(lines[index]);

      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const item = /^(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);

    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();

      const element = document.createElement(
        `h${Math.min(heading[1].length + 1, 5)}`,
      );

      element.append(inline(heading[2]));
      fragment.append(element);
    } else if (item) {
      const kind = item[1] ? "ul" : "ol";

      if (!list || list.tagName.toLowerCase() !== kind) {
        flush();
        list = document.createElement(kind);
        fragment.append(list);
      }

      const element = document.createElement("li");

      element.append(inline(item[2]));
      list.append(element);
    } else {
      list = null;
      paragraph.push(line);
    }
  }

  flush();
  return fragment;
}
