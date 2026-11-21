// Claude usage limits: 5H and 7D, from the newest reading of any
// Claude Code session. Readings come from the herdr-usage-bridge Claude Code
// mod: ~/.cache/claude-usage/<terminal>.json, each window kept by its kind.
// The bars carry a pace tick at how much of the window's time has passed.
// A third bar shows the focused agent's context window, from that terminal's
// own reading; empty (same height) when no Claude agent has the focus.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, home, watchFolder, focused, agents, props, run } from "herdr";
import * as fs from "fs/promises";

const FIVE_HOURS = 5 * 3600000;
const SEVEN_DAYS = 7 * 86400000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Each row: its label and which reported kinds it reads.
const ROWS = [
  { label: "5-hour", match: (k) => k === "five_hour", missing: "No 5-hour reading yet" },
  { label: "Weekly", match: (k) => k === "seven_day", missing: "No 7-day reading yet" },
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

// Folding (props.block): a click on the header folds the block to its title line, and back.
// The layout gives the block's id and open height (props.block, props.height); the
// fold is kept per screen in localStorage and applied with layout.resize.
const FOLDED_PX = 36;
function foldInit(view) { view.folded = localStorage.getItem("folded") === "1"; }
function foldSync(view) {
  const p = props(), id = p?.block;
  if (!id) return;
  const want = view.folded ? FOLDED_PX : (p.height ?? null);
  const have = find(layout(), id)?.size?.px;
  if (want == null || have === want) { view.askedPx = null; return; }
  if (view.askedPx !== want) { view.askedPx = want; run("layout.resize", { id, px: want }); }
}
function foldToggle(view, cx) {
  view.folded = !view.folded;
  localStorage.setItem("folded", view.folded ? "1" : "0");
  cx.notify();
}
// The header: chevron, title, and (folded) the summary on the right.
function foldHeader(view, title, t, open) {
  return h_flex().id("fold-header").flex_none().px(16).gap(6).items_center().text_size(11.5).font_medium().text_color(t.dim)
    .when(open, (el) => el.h(34).pt(10).pb(4)).when(!open, (el) => el.h(FOLDED_PX))
    .cursor_pointer().hover((s) => s.text_color(t.muted)).on_click((_e, cx) => foldToggle(view, cx))
    .child(div().w(10).flex_none().child(open ? "▾" : "▸"))
    .child(div().flex_1().min_w(0).truncate().child(title));
}

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
  if (!found) return { label, pct: null, note: row.missing };
  const { kind, w } = found;
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!Number.isNaN(reset) && reset <= now) return { label, pct: 0, note: "Reset" };
  const pct = clamp(w.percentUsed);
  if (Number.isNaN(reset)) return { label, pct, note: "" };
  const at = new Date(reset);
  const duration = durationOf(kind);
  const resets = `resets on ${DAYS[at.getDay()]} ${clock(at, true)}`;
  const note = `${resets} · ${span(reset - now)} left`;
  const pace = duration ? clamp((1 - (reset - now) / duration) * 100) : null;
  return { label, pct, note, resets, pace };
}

const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

// The focused agent's context fill: its terminal's reading, or an empty bar.
function contextMeter(reading, agent) {
  const label = "Context";
  if (!agent) return { label, pct: null, note: "No agent focused" };
  const c = reading?.context;
  if (!c?.window) return { label, pct: null, note: "No reading for this agent" };
  if (c.percent == null) return { label, pct: 0, note: `0 / ${tokens(c.window)} tokens`, context: true };
  return { label, pct: clamp(c.percent), note: `${tokens(c.tokens ?? 0)} / ${tokens(c.window)} tokens`, context: true };
}

// On or behind pace: the theme's quiet color. Ahead by up to 10 points: yellow; further: red.
function paceColor(t, m) {
  if (m.context) return m.pct < 50 ? t.muted : m.pct < 80 ? t.ansi3 : t.ansi1;
  if (m.pct == null || m.pace == null) return t.muted;
  const ahead = m.pct - m.pace;
  return ahead <= 0 ? t.muted : ahead <= 10 ? t.ansi3 : t.ansi1;
}

export default class Usage extends View {
  init(_props, cx) {
    foldInit(this);
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
      try { next.push({ file: name.slice(0, -5), ...JSON.parse(await fs.readFile(`${this.dir}/${name}`, "utf8")) }); } catch {}
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

  // The agent with the keyboard (a pane's or an agent block's), and its reading.
  focusedContext() {
    const f = focused();
    const address = f?.terminal ?? f?.agent;
    const agent = address ? agents().find((a) => a.address === address) : null;
    const reading = agent ? this.readings.find((r) => (r.terminal ?? r.file) === agent.address) : null;
    return contextMeter(reading, agent);
  }

  bar(m, t, h) {
    const pct = m.pct ?? 0;
    return div().relative().flex_1().min_w(0).h(h).rounded(h / 2).bg(t.raised)
      .when(pct > 0, (el) => el.child(div().absolute().left(0).top(0).bottom(0).rounded(h / 2)
        .w(`${Math.max(pct, 2)}%`).bg(paceColor(t, m))))
      .when(m.pace != null, (el) => el.child(div().absolute().top(-2).h(h + 4).w(2).rounded(1)
        .left(`${m.pace}%`).bg(t.foreground)));
  }

  row(m, t) {
    return v_flex().id(`meter-${m.label}`).gap(4).when(Boolean(m.note), (el) => el.tooltip(m.note))
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(12).text_color(t.muted).child(m.label))
        .child(div().text_size(12).text_color(m.pct == null ? t.dim : t.muted)
          .child(m.pct == null ? "—" : `${Math.round(m.pct)}%`)))
      .child(h_flex().child(this.bar(m, t, 6)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(m.resets ?? m.note));
  }

  compact(m, t) {
    return v_flex().id(`meter-${m.label}`).items_center().gap(3).when(Boolean(m.note), (el) => el.tooltip(m.note))
      .child(div().text_size(9.5).font_semibold().text_color(t.dim).child(m.label))
      .child(div().text_size(11).font_semibold().text_color(m.pct == null ? t.dim : paceColor(t, m))
        .child(m.pct == null ? "—" : `${Math.round(m.pct)}`))
      .child(h_flex().w(24).child(this.bar({ ...m, pace: null }, t, 3)));
  }

  // One line per meter: label, bar, percent; the reset time or token count in its tooltip.
  line(m, t) {
    return h_flex().id(`line-${m.label}`).h(20).gap(8).items_center().when(Boolean(m.note), (el) => el.tooltip(m.note))
      .child(div().w(52).flex_none().text_size(12).text_color(t.muted).child(m.label))
      .child(this.bar(m, t, 5))
      .child(div().w(34).flex_none().flex().justify_end().text_size(12).text_color(m.pct == null ? t.dim : m.context ? paceColor(t, m) : t.muted)
        .child(m.pct == null ? "—" : `${Math.round(m.pct)}%`));
  }

  render() {
    const t = theme();
    const meters = [...ROWS.map((row) => meter(row, this.pick(row), this.now)), this.focusedContext()];
    if (narrow()) {
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).items_center().justify_center().gap(10)
        .children(meters.map((m) => this.compact(m, t)));
    }
    // The sidebar: compact lines under a header that folds.
    if (props()?.block) {
      foldSync(this);
      const open = !this.folded;
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
        .child(foldHeader(this, "Claude Usage", t, open))
        .when(open, (el) => el.child(v_flex().px(16).pb(12).gap(6).children(meters.map((m) => this.line(m, t)))));
    }
    // The right-hand panel: the full rows, details written out, as a card like the other panels.
    if (props()?.panel) {
      return v_flex().id("usage-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_size(13)
        .child(h_flex().h(38).flex_none().px(12).items_center().border_b(1).border_color(t.border).font_semibold().child("Claude Usage"))
        .child(v_flex().p(16).gap(14).children(meters.map((m) => this.row(m, t))));
    }
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().h(41).pt(14).pb(5).px(16).flex_none().items_center().text_size(11.5).font_medium().text_color(t.dim).child("Claude Usage"))
      .child(v_flex().px(16).pb(16).gap(8).children(meters.map((m) => this.row(m, t))));
  }
}
