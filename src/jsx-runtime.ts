interface HasChildren {
  id?: string;
  style?: Partial<CSSStyleDeclaration>;
  class?: string;
  children?: any;
  onclick?: (event: MouseEvent) => void;
  disabled?: boolean;
  type?: string;
  value?: string;
  oninput?: (event: InputEvent) => void;
  src?: string;
  alt?: string;
}

interface SpacingElement extends HasChildren {
  space?: number;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      spaceRow: SpacingElement;
      spaceCol: SpacingElement;
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
