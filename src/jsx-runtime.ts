interface HasChildren {
  id?: string;
  class?: string;
  children?: any;
  onclick?: (event: MouseEvent) => void;
  disabled?: boolean;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
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

  const element = document.createElement(tag);

  if (props) {
    Object.keys(props).forEach((key) => {
      const value = props[key];
      if (key.startsWith("on") && typeof value === "function") {
        const eventName = key.toLowerCase().substring(2);
        element.addEventListener(eventName, value);
      } else if (key === "className") {
        element.setAttribute("class", value);
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
