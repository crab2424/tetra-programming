/// JSX風構文を提供するLibrary

interface HasChildren {
  id?: string;
  style?: Partial<CSSStyleDeclaration>;
  class?: string;
  children?: any;
  onclick?: (event: MouseEvent) => void;
  disabled?: boolean;
  type?: string;
  value?: string | number;
  oninput?: (event: InputEvent) => void;
  onchange?: (event: Event) => void;
  src?: string;
  alt?: string;
  title?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  placeholder?: string;
  name?: string;
  checked?: boolean;
}

interface SpacingElement extends HasChildren {
  space?: number;
}

interface BreakableDiv extends HasChildren {
  body?: string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      /** Row方向の余白を追加するエレメント (拡張) */
      spaceRow: SpacingElement;
      /** Column方向の余白を追加するエレメント (拡張) */
      spaceCol: SpacingElement;
      /** "\n"による改行を許可するエレメント (拡張) */
      breakableDiv: BreakableDiv;

      [elemName: string]: HasChildren;
    }
  }
}

export function jsx(
  tag: string,
  props: any,
  ...children: any[]
): HTMLElement | DocumentFragment {
  if (tag === "Fragment") {
    const fragment = document.createDocumentFragment();
    appendChildren(fragment, children);
    return fragment;
  }

  if (tag === "spaceRow") {
    const space = props?.space ?? 0;
    const rowSpaceElement = document.createElement("div");
    rowSpaceElement.style = `height: ${space}px; width: 100%; opacity: 0; pointer-events: none; user-select: none;`;
    return rowSpaceElement;
  } else if (tag === "spaceCol") {
    const space = props?.space ?? 0;
    const colSpaceElement = document.createElement("div");
    colSpaceElement.style = `width: ${space}px; height: 100%; opacity: 0; pointer-events: none; user-select: none;`;
    return colSpaceElement;
  } else if (tag === "breakableDiv") {
    const div = document.createElement("div");
    const body: string = (props?.body as string) ?? "";
    body.split("\n").forEach((line, index) => {
      div.appendChild(document.createTextNode(line));
      if (index < body.split("\n").length - 1) {
        div.appendChild(document.createElement("br"));
      }
    });
    return div;
  }

  const element = document.createElement(tag);

  if (props) {
    Object.keys(props).forEach((key) => {
      const value = props[key];
      if (key.startsWith("on") && typeof value === "function") {
        const eventName = key.toLowerCase().substring(2);
        element.addEventListener(eventName, value);
      } else if (key === "className") {
        element.setAttribute("class", value);
      } else if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
      } else if (value !== null && value !== undefined) {
        element.setAttribute(key, String(value));
      }
    });
  }

  appendChildren(element, children);

  return element;
}

function appendChildren(parent: Node, children: any[]) {
  children.flat(Infinity).forEach((child) => {
    if (child instanceof Node) {
      parent.appendChild(child);
    } else if (child !== null && child !== undefined && child !== false) {
      parent.appendChild(document.createTextNode(String(child)));
    }
  });
}

export const Fragment = "Fragment";
