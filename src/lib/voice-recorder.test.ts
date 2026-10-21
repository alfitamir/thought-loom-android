import { describe, expect, it, vi } from "vitest";
import { createVoiceRecorder, MIC_DENIED } from "./voice-recorder";

class FakeSR {
  static all: FakeSR[] = [];
  lang = ""; continuous = true; interimResults = false; maxAlternatives = 1;
  onstart: any; onaudiostart: any; onresult: any; onerror: any; onend: any;
  started = false;
  constructor() { FakeSR.all.push(this); }
  start() { this.started = true; this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
  say(text: string, final = true) {
    const r: any = [{ transcript: text }]; r.isFinal = final;
    this.onresult?.({ resultIndex: 0, results: [r] });
  }
}

function setup() {
  FakeSR.all = [];
  vi.useFakeTimers();
  const texts: string[] = [];
  let listening = false;
  let msg = "";
  const rec = createVoiceRecorder(FakeSR, {
    onText: (t) => texts.push(t),
    onListening: (on) => { listening = on; },
    onMessage: (m) => { msg = m; },
  });
  return { rec, texts, isListening: () => listening, msg: () => msg, last: () => FakeSR.all.at(-1)! };
}

describe("voice recording stops only when the user presses stop", () => {
  it("keeps recording after Android ends the session on silence", () => {
    const s = setup();
    s.rec.start();
    s.last().say("الفكرة الأولى");
    s.last().onend();
    vi.advanceTimersByTime(3000);
    expect(FakeSR.all.length).toBe(2);
    expect(s.isListening()).toBe(true);
    s.last().say("والفكرة الثانية");
    expect(s.texts).toEqual(["الفكرة الأولى", "والفكرة الثانية"]);
  });

  it("keeps recording through repeated errors", () => {
    const s = setup();
    s.rec.start();
    for (let i = 0; i < 20; i++) {
      s.last().onerror({ error: "network" });
      s.last().onend();
      vi.advanceTimersByTime(3000);
    }
    expect(s.rec.isRecording()).toBe(true);
    expect(s.isListening()).toBe(true);
    expect(FakeSR.all.length).toBe(21);
  });

  it("keeps words that were cut off before becoming final", () => {
    const s = setup();
    s.rec.start();
    s.last().say("كلام لم يكتمل", false);
    s.last().onend();
    expect(s.texts).toEqual(["كلام لم يكتمل"]);
  });

  it("stops and never restarts after the stop press", async () => {
    const s = setup();
    s.rec.start();
    await s.rec.stop();
    vi.advanceTimersByTime(20000);
    expect(FakeSR.all.length).toBe(1);
    expect(s.isListening()).toBe(false);
  });

  it("stops only when the phone refuses the microphone from the start", () => {
    const s = setup();
    FakeSR.prototype.start = function (this: FakeSR) { this.started = true; };
    s.rec.start();
    s.last().onerror({ error: "not-allowed" });
    expect(s.isListening()).toBe(false);
    expect(s.msg()).toBe(MIC_DENIED);
    FakeSR.prototype.start = function (this: FakeSR) { this.started = true; this.onstart?.(); };
  });
});
