/** オンライン対戦の結果表示モデルと描画をまとめる。 */

export type OnlineOutcome = "win" | "lose" | "draw";

export interface OnlineResultModel {
  outcome: OnlineOutcome;
  winnerName: string | null;
  selfScore: number | null;
  selfPrimaryLabel: "LINES" | "MAX CHAIN";
  selfPrimaryValue: number | null;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

export function renderOnlineResult(model: OnlineResultModel): void {
  const title = document.getElementById("ol-winner-title");
  if (title) {
    title.textContent = model.outcome === "win"
      ? "YOU WIN!"
      : model.outcome === "lose"
        ? "YOU LOSE"
        : "DRAW";
    title.classList.toggle("ol-result-win", model.outcome === "win");
    title.classList.toggle("ol-result-lose", model.outcome === "lose");
    title.classList.toggle("ol-result-draw", model.outcome === "draw");
  }

  setText(
    "ol-winner-name",
    model.winnerName && model.outcome !== "draw"
      ? `WINNER: ${model.winnerName}`
      : "",
  );
  setText(
    "ol-result-outcome",
    model.outcome === "win" ? "WIN" : model.outcome === "lose" ? "LOSE" : "DRAW",
  );
  setText("ol-result-self-score", model.selfScore === null ? "—" : String(model.selfScore));
  setText("ol-result-self-lines", model.selfPrimaryValue === null ? "—" : String(model.selfPrimaryValue));
  setText("ol-result-self-lines-label", `YOUR ${model.selfPrimaryLabel}`);
}

export function resetOnlineResult(): void {
  renderOnlineResult({
    outcome: "draw",
    winnerName: null,
    selfScore: null,
    selfPrimaryLabel: "LINES",
    selfPrimaryValue: null,
  });
}
