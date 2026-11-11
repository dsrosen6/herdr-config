// Asks for an optional session name, then opens a new tab running Claude.
// With a name: the tab gets it as typed, and Claude gets it lowercased with
// spaces as dashes (`claude --name fix-login`). Empty: a plain `claude` tab.
// Enter starts, Esc cancels.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class ClaudeNew extends View {
  init(_props, cx) {
    this.text = "";
    this.input = InputState.new({ value: "", placeholder: "session name (optional)" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  submit() {
    const name = this.text.trim();
    this.close();
    const session = name.toLowerCase().replace(/\s+/g, "-");
    run("tab.new", name ? { name, argv: ["claude", "--name", session] } : { argv: ["claude"] });
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    return v_flex().id("claude-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("New Claude session"))
      .child(div().text_color(t.muted).child("Names the tab and the Claude session. Leave empty for the defaults."))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1)
        .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .child(div().flex_1())
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↵ start · esc cancel"));
  }
}
