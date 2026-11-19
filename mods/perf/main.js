// Performance: this Mac's CPU and RAM on one line, colored at warning and
// error levels. CPU is the average of back-to-back 5-second iostat samples
// over the last 30 seconds, RAM is read from vm_stat
// (used = app memory + wired + compressed, as Activity Monitor counts it).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, exec } from "herdr";

const POLL_MS = 5000;
const CPU_SAMPLE_S = 5;
const CPU_WINDOW_MS = 30000;
const CPU_LEVELS = { warn: 70, error: 90 };
const RAM_LEVELS = { warn: 80, error: 90 };
const PRESSURE_LEVELS = { warn: 50, error: 75 };
const GB = 1024 ** 3;
// Nerd Font glyphs: nf-oct-cpu and nf-fa-memory.
const ICON_FONT = "FiraCode Nerd Font";
const CPU_ICON = "\uf4bc";
const RAM_ICON = "\uefc5";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function level(t, pct, levels) {
  if (pct == null) return t.dim;
  return pct >= levels.error ? t.ansi1 : pct >= levels.warn ? t.ansi3 : t.muted;
}

async function sampleCpu() {
  // Second row of numbers covers the last CPU_SAMPLE_S seconds; the first is since boot.
  const r = await exec("iostat", ["-n0", "-c2", `-w${CPU_SAMPLE_S}`], { timeout: CPU_SAMPLE_S * 1000 + 5000 });
  const rows = r.stdout.trim().split("\n").filter((l) => /^\s*\d/.test(l));
  const [us, sy, , l1, l5, l15] = rows.at(-1).trim().split(/\s+/).map(Number);
  return { pct: us + sy, user: us, sys: sy, load: [l1, l5, l15] };
}

async function sampleRam() {
  const [vm, sys] = await Promise.all([
    exec("vm_stat", [], { timeout: 5000 }),
    exec("sysctl", ["-n", "hw.memsize", "kern.memorystatus_level"], { timeout: 5000 }),
  ]);
  const page = Number(/page size of (\d+)/.exec(vm.stdout)?.[1] ?? 16384);
  const get = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vm.stdout)?.[1] ?? 0) * page;
  const [total, free] = sys.stdout.trim().split("\n").map(Number);
  const compressed = get("Pages occupied by compressor");
  const used = get("Anonymous pages") - get("Pages purgeable") + get("Pages wired down") + compressed;
  return { used, total, compressed, pct: (used / total) * 100, pressure: 100 - free };
}

export default class Perf extends View {
  init(_props, cx) {
    this.cpu = null;
    this.cpuSamples = [];
    this.ram = null;
    this.busy = false;
    this.refreshRam(cx);
    cx.timer.every(POLL_MS, (cx) => this.refreshRam(cx));
    // iostat itself waits CPU_SAMPLE_S, so back-to-back samples cover all the time.
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          const s = await sampleCpu();
          const now = Date.now();
          this.cpuSamples = [...this.cpuSamples, { at: now, pct: s.pct }].filter((x) => now - x.at < CPU_WINDOW_MS);
          const avg = this.cpuSamples.reduce((sum, x) => sum + x.pct, 0) / this.cpuSamples.length;
          this.cpu = { ...s, now: s.pct, pct: avg };
        } catch {
          this.cpu = null;
          await exec("sleep", [String(CPU_SAMPLE_S)]).catch(() => {});
        }
        cx.notify();
      }
    });
  }

  refreshRam(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try { this.ram = await sampleRam(); } catch { this.ram = null; }
      this.busy = false;
      cx.notify();
    });
  }

  // values: one [text, color] or several, each colored on its own.
  stat(id, label, values, tip, t) {
    return h_flex().id(id).gap(4).items_center().when(Boolean(tip), (el) => el.tooltip(tip))
      .child(div().w(18).flex_none().font_family(ICON_FONT).text_size(13).text_color(t.muted).child(label))
      .child(h_flex().text_size(12).children(values.map(([text, color]) => div().text_color(color).child(text))));
  }

  render() {
    const t = theme();
    const { cpu, ram } = this;
    const cpuColor = level(t, cpu?.pct, CPU_LEVELS);
    const ramColor = level(t, ram?.pct, RAM_LEVELS);
    const pressureColor = level(t, ram?.pressure, PRESSURE_LEVELS);
    const cpuText = cpu ? `${Math.round(cpu.pct)}%` : "—";
    const ramText = ram ? `${(ram.used / GB).toFixed(1)}GB / ${Math.round(ram.total / GB)}GB / ` : "—";
    const cpuTip = cpu && `30s average · last 5s ${Math.round(cpu.now)}% (user ${cpu.user}% · system ${cpu.sys}%) · load ${cpu.load.join(" / ")}`;
    const ramTip = ram && `${Math.round(ram.pct)}% used · ${ram.pressure}% memory pressure · ${(ram.compressed / GB).toFixed(1)} GB compressed`;
    const pressureText = ram ? `${ram.pressure}%` : "—";

    if (narrow()) {
      const cell = (id, label, value, color, tip) => v_flex().id(id).items_center().gap(3).when(Boolean(tip), (el) => el.tooltip(tip))
        .child(div().font_family(ICON_FONT).text_size(12).text_color(t.dim).child(label))
        .child(div().text_size(11).font_semibold().text_color(color).child(value));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).items_center().justify_center().gap(10)
        .child(cell("cpu", CPU_ICON, cpu ? `${Math.round(cpu.pct)}` : "—", cpuColor, cpuTip))
        .child(cell("ram", RAM_ICON, ram ? `${Math.round(ram.pct)}` : "—", ramColor, ramTip));
    }

    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().h(41).pt(14).pb(5).px(16).flex_none().items_center().text_size(11.5).font_medium().text_color(t.dim).child("Performance"))
      .child(h_flex().px(16).pb(16).justify_between().items_center()
        .child(this.stat("cpu", CPU_ICON, [[cpuText, cpuColor]], cpuTip, t))
        .child(this.stat("ram", RAM_ICON, ram ? [[ramText, ramColor], [pressureText, pressureColor]] : [["—", t.dim]], ramTip, t)));
  }
}
