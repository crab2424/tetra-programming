import {
  jsx,
} from "./jsx-runtime";
import { randomUUID } from "./online/uuid";

export const ToastColor = {
  Success: ["#4CAF50", "#144929"],
  Error: ["#F44336", "#4A1400"],
  Warning: ["#FF9800", "#4A2900"],
  Info: ["#2196F3", "#0B1449"],
} as const;
type ToastColor = typeof ToastColor[keyof typeof ToastColor];

/**
 * トーストメッセージを表示する
 * @param title メッセージタイトル
 * @param message メッセージ本文
 * @param color トーストの色 (ToastColor)
 */
export const showToast = (title: string, message: string, color: ToastColor): void => {
  const toast = document.getElementById("global-toast") as HTMLDivElement | null;
  if (!toast) return;

  const toastId = randomUUID();

  const newToast = <div id={`global-toast-${toastId}`} class="flex flex-col toast" style={{ backgroundColor: color[0], borderColor: color[1], boxShadow: `0 2px 4px ${color[1]}` }}>
    <div class="flex flex-row space-between" style={{ fontWeight: "bold", fontSize: "16px" }}>
      <div>{title}</div>
      <div onclick={() => {
        const toastElement = document.getElementById(`global-toast-${toastId}`) as HTMLDivElement | null;
        if (toastElement) {
          toastElement.style.animation = "fadeout 0.5s ease";
          setTimeout(() => {
            toastElement.remove();
          }, 500);
        }
      }} style={{
        cursor: "pointer"
      }}>×</div>
    </div>
    <div style={{ fontSize: "12px" }}>{message}</div>
  </div>

  toast.appendChild(newToast);
  newToast.style.animation = "fadein 0.5s ease-out";

  setTimeout(() => {
    const toastElement = document.getElementById(`global-toast-${toastId}`) as HTMLDivElement | null;
    if (toastElement) {
      toastElement.style.animation = "fadeout 0.5s ease";
      setTimeout(() => {
        try {
          toastElement.remove();
        } catch (e) {
          ;
        }
      }, 500);
    }
  }, 5000);
};
