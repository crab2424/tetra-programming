// @ts-check
/**
 * ZONE BATTLE の部屋の MATCH SETTINGS（設計 source_assets/memory/mode/tet_zone/tetlabo-zone-online-design.md §4）。
 *
 * ローカル ZONE BATTLE の VS 設定（public/config/vs_settings.js _renderZoneBattleSections）と同じ
 * ALL / MARGIN / PHASE のタブと、PHASE の「01 / 02 / 03 の小タブ＋4 行（＋進む条件）」の作り。
 * 行の見た目・キー操作は今のルーム画面の MATCH SETTINGS（.ms-row / .ms-row-editable。online.tsx msRowItem）と同じ。
 *
 * - タブ・小タブはこの端末だけの表示の切替（送らない）。オーナー以外も見て回れる。
 * - 値を変えるとオーナーが部屋設定を送り、ルームの通知で描き直される（描き直しても開いているタブ・小タブ・
 *   フォーカスはそのまま）。タブを切り替えたときだけ軽く出す（ローカルの VS 設定と同じ settings-tab-in）。
 * - 選択肢はローカルの ZONE BATTLE の定数をそのまま使う（サーバーの検査 tetra-server game.rs と手で合わせる）。
 */
import { jsx } from "../jsx-runtime";
import type { OnlineZoneMatchSetting, ZonePhaseRow } from "./payload";

declare const MARGIN_TIME_STEPS: number[];
declare const MARGIN_SCORE_STEPS: number[];
declare const PHASE_SCORE_STEPS: number[];
declare const PHASE_TIME_STEPS: number[];
declare const VS_ZONE_TIME_OPTIONS: number[];
declare const VS_ZONE_CHARGE_OPTIONS: number[];
declare const TET_MARGIN_SCORE_STEP: number;

export type ZoneSettingsTab = "all" | "margin" | "phase";
export const ZONE_SETTINGS_TABS: ZoneSettingsTab[] = ["all", "margin", "phase"];

/** 描き直しをまたいで残す表示の状態（online.tsx が持つ） */
export interface ZoneSettingsView {
  tab: ZoneSettingsTab;
  phase: 1 | 2 | 3;
}

type Patch = Partial<OnlineZoneMatchSetting>;

export interface ZoneSettingsOptions {
  setting: OnlineZoneMatchSetting;
  isOwner: boolean;
  view: ZoneSettingsView;
  send: (patch: Patch) => void;
}

const HOLE_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const SET_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const MULT_STEPS = Array.from({ length: 31 }, (_, i) => Math.round(i) / 10);
const MARGIN_SCORE_STEP_DEFAULT = 20000;

const fmtMarginTime = (v: number) => (v === 0 ? "INSTANT" : `${v}s`);
const fmtMarginScore = (v: number) => (v === 0 ? "INSTANT" : `${v / 1000}K`);
const fmtScore = (v: number) => `${v / 1000}K`;
const fmtTime = (v: number) => `${v / 1000}s`;
const pad2 = (p: number) => String(p).padStart(2, "0");

/** 「前のフェーズに足す」しきい値を試合の始まりからの値へ（vs_settings.js _phaseAbs と同じ） */
function phaseAbs(table: ZonePhaseRow[]): { score: number; timeMs: number }[] {
  let score = 0, timeMs = 0;
  return table.map((r, i) => {
    if (i > 0) { score += r.scoreAdd; timeMs += r.timeAdd; }
    return { score, timeMs };
  });
}

// ── 行（.ms-row。オーナーだけ .ms-row-editable ＝ 1 行 1 フォーカス）──────────────────

function label(text: string, sub?: string) {
  return (
    <span class="ms-label">
      {text}
      {sub ? <span class="ms-sub">{" " + sub}</span> : ""}
    </span>
  );
}

/**
 * ボタンを並べた行（ON/OFF・TIME/SCORE・ZONE TIME の 6 択など）。←/→ で隣へ（msRowItem）。
 * editable を明示すると、オーナー以外でも選べる（小タブ用）。
 */
function segRow<T>(
  key: string,
  text: string,
  sub: string | undefined,
  options: { label: string; value: T }[],
  current: T,
  onPick: (v: T) => void,
  editable: boolean,
): HTMLElement {
  const cur = options.find((o) => o.value === current);
  return (
    <div class={"ms-row" + (editable ? " ms-row-editable" : "")} data-focus-key={"ms:" + key}>
      {label(text, sub)}
      {editable ? (
        <div class="ms-segment">
          {options.map((o) => (
            <button
              class={"ms-seg-btn" + (o.value === current ? " active" : "")}
              onclick={(e: MouseEvent) => {
                const btn = e.currentTarget as HTMLElement;
                if (btn.classList.contains("active")) return;
                // 返事で描き直されるまでの間も見た目を合わせる
                btn.parentElement?.querySelectorAll(".ms-seg-btn").forEach((b) => {
                  b.classList.toggle("active", b === btn);
                });
                onPick(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <span class="ms-readonly">{cur ? cur.label : String(current)}</span>
      )}
    </div>
  ) as HTMLElement;
}

const stepTimers = new Map<string, number>();

/**
 * 決まった値の並びをつまみで選ぶ行（MARGIN TIME・HOLE RATE・TRIGGER SCORE など。ローカルの _buildStepSliderRow と同じ考え）。
 * ←/→ で 1 つずつ（見た目はすぐ・送るのは連打をまとめて 1 回）。
 */
function stepRow(
  key: string,
  text: string,
  sub: string | undefined,
  steps: number[],
  fmt: (v: number) => string,
  current: number,
  onCommit: (v: number) => void,
  editable: boolean,
): HTMLElement {
  let idx = steps.indexOf(current);
  if (idx < 0) idx = 0;
  let committed = idx;
  const commit = (i: number) => {
    if (i === committed) return;
    committed = i;
    onCommit(steps[i]);
  };
  const row = (
    <div class={"ms-row ms-row-slider" + (editable ? " ms-row-editable" : "")} data-focus-key={"ms:" + key}>
      {label(text, sub)}
      {editable ? (
        <div class="ms-slider-wrap">
          <input
            class="ms-slider"
            type="range"
            min={0}
            max={steps.length - 1}
            step={1}
            value={idx}
            oninput={(e: Event) => {
              const i = Number((e.target as HTMLInputElement).value);
              const v = (e.target as HTMLElement).parentElement?.querySelector<HTMLElement>(".ms-step-value");
              if (v) v.textContent = fmt(steps[i]);
            }}
            onchange={(e: Event) => commit(Number((e.target as HTMLInputElement).value))}
          />
          <span class="ms-step-value">{fmt(steps[idx])}</span>
        </div>
      ) : (
        <span class="ms-readonly">{fmt(current)}</span>
      )}
    </div>
  ) as HTMLElement;
  (row as any).__msStep = (dir: number) => {
    const slider = row.querySelector<HTMLInputElement>(".ms-slider");
    const value = row.querySelector<HTMLElement>(".ms-step-value");
    if (!slider) return;
    const i = Math.max(0, Math.min(steps.length - 1, Number(slider.value) + dir));
    slider.value = String(i);
    if (value) value.textContent = fmt(steps[i]);
    const prev = stepTimers.get(key);
    if (prev !== undefined) clearTimeout(prev);
    stepTimers.set(key, window.setTimeout(() => {
      stepTimers.delete(key);
      commit(i);
    }, 250));
  };
  return row;
}

/** 使わない側の行を薄くする（ローカルの is-inert と同じ。操作はできる） */
function inert(row: HTMLElement, on: boolean): HTMLElement {
  row.classList.toggle("is-inert", on);
  return row;
}

/** タブ・小タブを切り替えたときだけ軽く出す（描き直しでは動かさない） */
function replayEnter(el: Element): void {
  el.classList.remove("is-entering");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("is-entering");
}

/**
 * ZONE BATTLE の MATCH SETTINGS の中身（.ms-grid）。online.tsx の .ol-ms-section の中に置く。
 */
export function buildZoneSettingsGrid(opts: ZoneSettingsOptions): HTMLElement {
  const { setting: s, isOwner, view, send } = opts;
  const yesNo = [{ label: "ON", value: true }, { label: "OFF", value: false }];
  const marginTimes = MARGIN_TIME_STEPS;
  const marginScores = MARGIN_SCORE_STEPS;
  const marginStep = typeof TET_MARGIN_SCORE_STEP === "number" ? TET_MARGIN_SCORE_STEP : MARGIN_SCORE_STEP_DEFAULT;
  const abs = phaseAbs(s.phaseTable);
  const byTime = s.phaseTrigger === "time";
  const absLabel = (p: number) => (byTime ? fmtTime(abs[p - 1].timeMs) : abs[p - 1].score.toLocaleString("en-US"));
  const phaseStartSub = (p: number) => (p <= 1 ? "(start)" : `(${absLabel(p)}~)`);

  const setRow = (p: number, k: keyof ZonePhaseRow, v: number) => {
    const table = s.phaseTable.map((r) => ({ ...r }));
    table[p - 1][k] = v;
    send({ phaseTable: table });
  };

  // 4 行の組（HOLE RATE in / between・ZONE TIME・ZONE CHARGE）
  const valueRows = (prefix: string, get: { holeIn: number; holeBetween: number; time: number; charge: number },
    put: (k: "holeIn" | "holeBetween" | "time" | "charge", v: number) => void): HTMLElement[] => [
    stepRow(`${prefix}.holeIn`, "HOLE RATE", "(in chunk)", HOLE_STEPS, (v) => `${v}%`, get.holeIn, (v) => put("holeIn", v), isOwner),
    stepRow(`${prefix}.holeBetween`, "HOLE RATE", "(between)", HOLE_STEPS, (v) => `${v}%`, get.holeBetween, (v) => put("holeBetween", v), isOwner),
    segRow(`${prefix}.time`, "ZONE TIME", "(sec / 25%)", VS_ZONE_TIME_OPTIONS.map((v) => ({ label: `${v / 1000}s`, value: v })),
      get.time, (v) => put("time", v), isOwner),
    segRow(`${prefix}.charge`, "ZONE CHARGE", "(lines / 25%)", VS_ZONE_CHARGE_OPTIONS.map((v) => ({ label: String(v), value: v })),
      get.charge, (v) => put("charge", v), isOwner),
  ];

  // ── ALL ──
  const all = (
    <div class="ol-ms-panel" data-tab="all">
      {stepRow("setTarget", "SET TO", undefined, SET_STEPS, (v) => `${v} win${v > 1 ? "s" : ""}`, s.setTarget, (v) => send({ setTarget: v }), isOwner)}
      {stepRow("garbageMultiplier", "GARBAGE ×", undefined, MULT_STEPS, (v) => `${v.toFixed(1)}x`,
        MULT_STEPS.reduce((a, b) => (Math.abs(b - s.garbageMultiplier) < Math.abs(a - s.garbageMultiplier) ? b : a), 1),
        (v) => send({ garbageMultiplier: v }), isOwner)}
      {segRow("holdEnabled", "HOLD", undefined, yesNo, s.holdEnabled, (v) => send({ holdEnabled: v }), isOwner)}
      {segRow("b2bBonus", "B2B BONUS", undefined, yesNo, s.b2bBonus, (v) => send({ b2bBonus: v }), isOwner)}
      {segRow("garbageDamageOnClear", "DMG ON CLR", undefined, yesNo, s.garbageDamageOnClear, (v) => send({ garbageDamageOnClear: v }), isOwner)}
      {segRow("zoneSplit", "ZONE ATTACK", undefined, [{ label: "SPLIT", value: true }, { label: "MERGE", value: false }],
        s.zoneSplit, (v) => send({ zoneSplit: v }), isOwner)}
    </div>
  ) as HTMLElement;

  // ── MARGIN ──
  const marginOff = !s.marginEnabled;
  const margin = (
    <div class="ol-ms-panel" data-tab="margin">
      {segRow("marginEnabled", "MARGIN", undefined, yesNo, s.marginEnabled, (v) => send({ marginEnabled: v }), isOwner)}
      {inert(segRow("marginTrigger", "MARGIN TRIGGER", undefined, [{ label: "TIME", value: "time" }, { label: "SCORE", value: "score" }],
        s.marginTrigger, (v) => send({ marginTrigger: v as "time" | "score" }), isOwner), marginOff)}
      {inert(stepRow("marginTime", "MARGIN TIME", undefined, marginTimes, fmtMarginTime, s.marginTime, (v) => send({ marginTime: v }), isOwner),
        marginOff || s.marginTrigger === "score")}
      {inert(stepRow("marginScore", "MARGIN SCORE", `(+1 / ${marginStep / 1000}K)`, marginScores, fmtMarginScore, s.marginScore,
        (v) => send({ marginScore: v }), isOwner), marginOff || s.marginTrigger !== "score")}
    </div>
  ) as HTMLElement;

  // ── PHASE ──
  const phaseOn = s.phase;
  const groupNote = phaseOn
    ? "フェーズごとに、おじゃまの穴の変わり方と ZONE の長さ・たまり方を決める"
    : "PHASE OFF の試合で通して使う値";
  const sets: HTMLElement[] = [];
  for (const p of [1, 2, 3] as const) {
    const r = s.phaseTable[p - 1];
    const rows = valueRows(`p${p}`, { holeIn: r.holeRate, holeBetween: r.holeChunk, time: r.zoneTime, charge: r.zoneCharge },
      (k, v) => setRow(p, ({ holeIn: "holeRate", holeBetween: "holeChunk", time: "zoneTime", charge: "zoneCharge" } as const)[k], v));
    if (p >= 2) {
      // このフェーズへ進むしきい値（前のフェーズに足す値）。PHASE TRIGGER に合う方だけ
      const from = `(+ PHASE ${pad2(p - 1)})`;
      rows.push(byTime
        ? stepRow(`p${p}.timeAdd`, "TRIGGER TIME", from, PHASE_TIME_STEPS,
          (v) => (p === 2 ? `+${fmtTime(v)}` : `+${fmtTime(v)} (${fmtTime(abs[p - 1].timeMs)})`), r.timeAdd, (v) => setRow(p, "timeAdd", v), isOwner)
        : stepRow(`p${p}.scoreAdd`, "TRIGGER SCORE", from, PHASE_SCORE_STEPS,
          (v) => (p === 2 ? `+${fmtScore(v)}` : `+${fmtScore(v)} (${fmtScore(abs[p - 1].score)})`), r.scoreAdd, (v) => setRow(p, "scoreAdd", v), isOwner));
    }
    sets.push(<div class="ol-ms-phase-set" data-set={String(p)}>{rows}</div> as HTMLElement);
  }
  sets.push(
    <div class="ol-ms-phase-set" data-set="fixed">
      {valueRows("fixed", { holeIn: s.garbageHoleRate, holeBetween: s.garbageHoleChunk, time: s.zoneQuarterMs, charge: s.zoneQuarterLines },
        (k, v) => send(({ holeIn: { garbageHoleRate: v }, holeBetween: { garbageHoleChunk: v }, time: { zoneQuarterMs: v }, charge: { zoneQuarterLines: v } } as const)[k]))}
    </div> as HTMLElement,
  );

  const group = (
    <div class="ol-ms-group">
      <div class="ol-ms-group-head">
        <span class="ol-ms-group-label">{phaseOn ? "PER PHASE" : "FIXED"}</span>
        <span class="ol-ms-group-note">{groupNote}</span>
      </div>
    </div>
  ) as HTMLElement;
  // 01 / 02 / 03 の小タブ（この端末だけの表示の切替。オーナー以外も選べる）
  const phaseSelect = segRow("phaseSelect", "PHASE", phaseStartSub(view.phase),
    [1, 2, 3].map((p) => ({ label: pad2(p), value: p })), view.phase,
    (v) => {
      view.phase = v as 1 | 2 | 3;
      syncSets(true);
      const sub = phaseSelect.querySelector(".ms-sub");
      if (sub) sub.textContent = " " + phaseStartSub(view.phase);
    }, true);
  phaseSelect.classList.add("ol-ms-phase-select");
  if (!phaseOn) phaseSelect.style.display = "none";
  group.appendChild(phaseSelect);
  for (const set of sets) group.appendChild(set);
  const syncSets = (animate: boolean) => {
    const show = phaseOn ? String(view.phase) : "fixed";
    for (const set of sets) {
      const visible = set.dataset.set === show;
      if (visible && animate && set.style.display === "none") replayEnter(set);
      set.style.display = visible ? "" : "none";
    }
  };
  syncSets(false);

  const phaseTriggerSub = `(${[2, 3].map(absLabel).join(" / ")})`;
  const phase = (
    <div class="ol-ms-panel" data-tab="phase">
      {segRow("phase", "PHASE", undefined, yesNo, s.phase, (v) => send({ phase: v }), isOwner)}
      {inert(segRow("phaseTrigger", "PHASE TRIGGER", phaseTriggerSub, [{ label: "SCORE", value: "score" }, { label: "TIME", value: "time" }],
        s.phaseTrigger, (v) => send({ phaseTrigger: v as "score" | "time" }), isOwner), !phaseOn)}
      {group}
    </div>
  ) as HTMLElement;

  const panels = [all, margin, phase];
  const tabLabels: Record<ZoneSettingsTab, string> = { all: "ALL", margin: "MARGIN", phase: "PHASE" };
  const setTab = (tab: ZoneSettingsTab, animate: boolean) => {
    view.tab = tab;
    tabs.querySelectorAll<HTMLElement>(".opt-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    for (const panel of panels) {
      const on = panel.dataset.tab === tab;
      if (on && animate && !panel.classList.contains("active")) replayEnter(panel);
      panel.classList.toggle("active", on);
    }
  };
  // タブ（ローカルの VS 設定と同じ .option-toggle。行として 1 フォーカス、←/→ で切替。online.tsx tabsRowItem）
  const tabs = (
    <div class="option-toggle ol-ms-tabs ms-tabs-row" data-focus-key="ms-tabs">
      {ZONE_SETTINGS_TABS.map((t) => (
        <button class={"opt-btn" + (t === view.tab ? " active" : "")} data-tab={t} onclick={() => setTab(t, true)}>
          {tabLabels[t]}
        </button>
      ))}
    </div>
  ) as HTMLElement;
  (tabs as any).__msTabStep = (dir: number) => {
    const i = ZONE_SETTINGS_TABS.indexOf(view.tab);
    const next = ZONE_SETTINGS_TABS[Math.max(0, Math.min(ZONE_SETTINGS_TABS.length - 1, i + dir))];
    if (next !== view.tab) setTab(next, true);
  };
  setTab(view.tab, false);

  return (
    <div class="ms-grid ol-zone-ms">
      {tabs}
      {panels}
    </div>
  ) as HTMLElement;
}
