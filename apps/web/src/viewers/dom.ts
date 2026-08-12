export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function escapeHtml(value: string): string {
  const holder = document.createElement("span");
  holder.textContent = value;
  return holder.innerHTML;
}

/** The shared red-alert panel: used for denials, decode failures and unsupported payloads. */
export function noticePanel(code: string, heading: string, body: string): HTMLElement {
  const panel = el("div", "access-denied");
  panel.append(el("p", "denied-code", code), el("h3", undefined, heading), el("p", undefined, body));
  return panel;
}
