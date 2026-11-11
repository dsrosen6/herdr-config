// Claude usage limits: 5H and 7D, from the newest reading of any
// Claude Code session. Readings come from the herdr-usage-bridge Claude Code
// mod: ~/.cache/claude-usage/<terminal>.json, each window kept by its kind.
// The bars carry a pace tick at how much of the window's time has passed.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, home, watchFolder } from "herdr";
import * as fs from "fs/promises";

const FIVE_HOURS = 5 * 3600000;
const SEVEN_DAYS = 7 * 86400000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Each row: its label and which reported kinds it reads.
const ROWS = [
  { label: "5H", match: (k) => k === "five_hour", missing: "No 5-hour reading yet" },
  { label: "7D", match: (k) => k === "seven_day", missing: "No 7-day reading yet" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const clamp = (n) => Math.min(100, Math.max(0, n));
function clock(d, minutes) {
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? "AM" : "PM";
  if (!minutes && d.getMinutes() === 0) return `${h} ${ampm}`;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}
function span(ms) {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `${m}m`;
}
const durationOf = (kind) => (/five_hour/.test(kind) ? FIVE_HOURS : /seven_day/.test(kind) ? SEVEN_DAYS : null);

function meter(row, found, now) {
  const { label } = row;
  if (!found) return { label, pct: null, short: "", note: row.missing };
  const { kind, w } = found;
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!Number.isNaN(reset) && reset <= now) return { label, pct: 0, short: "", note: "Reset" };
  const pct = clamp(w.percentUsed);
  if (Number.isNaN(reset)) return { label, pct, short: "", note: "" };
  const at = new Date(reset);
  const duration = durationOf(kind);
  const soon = reset - now < 86400000;
  const short = soon ? span(reset - now) : `${DAYS[at.getDay()]} ${clock(at, false)}`;
  const note = soon
    ? `Resets ${clock(at, true)} · ${span(reset - now)} left`
    : `Resets ${DAYS[at.getDay()]} ${clock(at, false)}`;
  const pace = duration ? clamp((1 - (reset - now) / duration) * 100) : null;
  return { label, pct, short, note, pace };
}

const meterColor = (t, pct) => (pct < 50 ? t.ansi2 : pct < 75 ? t.ansi3 : t.ansi1);

export default class Usage extends View {
  init(_props, cx) {
    this.dir = `${home()}/.cache/claude-usage`;
    this.readings = [];
    this.now = Date.now();
    cx.timer.every(60000, (cx) => { this.now = Date.now(); cx.notify(); });
    cx.spawn(async (cx) => {
      try { await fs.mkdir(this.dir, { recursive: true }); } catch {}
      await this.load();
      cx.notify();
      for (;;) {
        try { await watchFolder(this.dir); } catch { break; }
        await this.load();
        cx.notify();
      }
    });
  }

  async load() {
    const next = [];
    let names = [];
    try { names = await fs.readdir(this.dir); } catch {}
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try { next.push(JSON.parse(await fs.readFile(`${this.dir}/${name}`, "utf8"))); } catch {}
    }
    this.readings = next.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    this.now = Date.now();
  }

  // The newest reading of a window any session reported.
  pick(row) {
    for (const r of this.readings) {
      for (const [kind, w] of Object.entries(r.limits ?? {})) if (row.match(kind)) return { kind, w };
    }
    return null;
  }

  bar(m, t, h) {
    const pct = m.pct ?? 0;
    return div().relative().flex_1().min_w(0).h(h).rounded(h / 2).bg(t.raised)
      .when(pct > 0, (el) => el.child(div().absolute().left(0).top(0).bottom(0).rounded(h / 2)
        .w(`${Math.max(pct, 2)}%`).bg(meterColor(t, pct))))
      .when(m.pace != null, (el) => el.child(div().absolute().top(-2).h(h + 4).w(2).rounded(1)
        .left(`${m.pace}%`).bg(t.foreground)));
  }

  row(m, t) {
    return h_flex().id(`meter-${m.label}`).h(18).gap(8).items_center().when(Boolean(m.note), (el) => el.tooltip(m.note))
      .child(div().w(24).flex_none().text_size(11).font_semibold().text_color(t.muted).child(m.label))
      .child(this.bar(m, t, 5))
      .child(div().w(32).flex_none().flex().justify_end().text_size(12).font_semibold()
        .text_color(m.pct == null ? t.dim : meterColor(t, m.pct))
        .child(m.pct == null ? "—" : `${Math.round(m.pct)}%`))
      .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).truncate().child(m.short));
  }

  compact(m, t) {
    return v_flex().id(`meter-${m.label}`).items_center().gap(3).when(Boolean(m.note), (el) => el.tooltip(m.note))
      .child(div().text_size(9.5).font_semibold().text_color(t.dim).child(m.label))
      .child(div().text_size(11).font_semibold().text_color(m.pct == null ? t.dim : meterColor(t, m.pct))
        .child(m.pct == null ? "—" : `${Math.round(m.pct)}`))
      .child(h_flex().w(24).child(this.bar({ ...m, pace: null }, t, 3)));
  }

  render() {
    const t = theme();
    const meters = ROWS.map((row) => meter(row, this.pick(row), this.now));
    if (narrow()) {
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).items_center().justify_center().gap(10)
        .children(meters.map((m) => this.compact(m, t)));
    }
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().h(31).pl(16).items_center().text_size(11.5).text_color(t.dim).child("Usage"))
      .child(v_flex().px(16).pb(10).gap(6).children(meters.map((m) => this.row(m, t))));
  }
}
