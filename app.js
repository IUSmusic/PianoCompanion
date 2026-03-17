(() => {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
  const KEYBOARD_START = 36; // C2
  const KEYBOARD_END = 96;   // C7
  const PIANO_WIDTH = 1240;
  const PRESET_CHORDS = [
    ["maj", "Major", [0, 4, 7]],
    ["min", "Minor", [0, 3, 7]],
    ["dim", "Diminished", [0, 3, 6]],
    ["aug", "Augmented", [0, 4, 8]],
    ["sus2", "Sus2", [0, 2, 7]],
    ["sus4", "Sus4", [0, 5, 7]],
    ["5", "Power 5", [0, 7]],
    ["6", "Major 6", [0, 4, 7, 9]],
    ["m6", "Minor 6", [0, 3, 7, 9]],
    ["7", "Dominant 7", [0, 4, 7, 10]],
    ["maj7", "Major 7", [0, 4, 7, 11]],
    ["m7", "Minor 7", [0, 3, 7, 10]],
    ["mMaj7", "Minor Major 7", [0, 3, 7, 11]],
    ["dim7", "Diminished 7", [0, 3, 6, 9]],
    ["m7b5", "Half-Diminished", [0, 3, 6, 10]],
    ["add9", "Add9", [0, 4, 7, 14]],
    ["madd9", "Minor Add9", [0, 3, 7, 14]],
    ["9", "Dominant 9", [0, 4, 7, 10, 14]],
    ["maj9", "Major 9", [0, 4, 7, 11, 14]],
    ["m9", "Minor 9", [0, 3, 7, 10, 14]],
    ["11", "11", [0, 4, 7, 10, 14, 17]],
    ["13", "13", [0, 4, 7, 10, 14, 21]],
  ].map(([id, name, intervals]) => ({ id, name, intervals }));

  const state = {
    midiAccess: null,
    midiInputs: [],
    heldKeys: new Set(),
    lastNote: null,
    lastVelocity: 0,
    selectedChordId: null,
    previewChordId: null,
    previewTimeout: null,
    isRecording: false,
    recordingStart: 0,
    recordedEvents: [],
    volume: 0.6,
    previewMs: 1200,
    audioContext: null,
    masterGain: null,
    voices: new Map(),
  };

  const els = {
    midiStatus: document.getElementById("midiStatus"),
    browserStatus: document.getElementById("browserStatus"),
    recordingBadge: document.getElementById("recordingBadge"),
    lastNote: document.getElementById("lastNote"),
    lastMidi: document.getElementById("lastMidi"),
    lastVelocity: document.getElementById("lastVelocity"),
    selectedChordLabel: document.getElementById("selectedChordLabel"),
    inputName: document.getElementById("inputName"),
    eventCount: document.getElementById("eventCount"),
    volumeSlider: document.getElementById("volumeSlider"),
    previewMsSlider: document.getElementById("previewMsSlider"),
    recordBtn: document.getElementById("recordBtn"),
    stopBtn: document.getElementById("stopBtn"),
    saveMidiBtn: document.getElementById("saveMidiBtn"),
    saveWavBtn: document.getElementById("saveWavBtn"),
    chordGrid: document.getElementById("chordGrid"),
    piano: document.getElementById("piano"),
    noteSummary: document.getElementById("noteSummary"),
  };

  function isBlackKey(midi) {
    return BLACK_PCS.has(((midi % 12) + 12) % 12);
  }

  function noteNameFromMidi(midi) {
    const pc = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return `${NOTE_NAMES[pc]}${octave}`;
  }

  function pitchClassName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12];
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function clampMidi(midi) {
    return Math.max(KEYBOARD_START, Math.min(KEYBOARD_END, midi));
  }

  function getActiveChord() {
    const id = state.previewChordId || state.selectedChordId;
    return PRESET_CHORDS.find((chord) => chord.id === id) || null;
  }

  function getChordNotes(rootMidi, chord) {
    return chord.intervals.map((interval) => clampMidi(rootMidi + interval));
  }

  function getHighlightedNotes() {
    const chord = getActiveChord();
    if (state.lastNote == null || !chord) return [];
    return getChordNotes(state.lastNote, chord);
  }

  async function ensureAudio() {
    if (!state.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new AudioCtx();
      state.masterGain = state.audioContext.createGain();
      state.masterGain.gain.value = state.volume;
      state.masterGain.connect(state.audioContext.destination);
    }
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
    state.masterGain.gain.value = state.volume;
    return state.audioContext;
  }

  async function noteOn(midi, velocity = 100) {
    const ctx = await ensureAudio();
    if (!ctx || state.voices.has(midi)) return;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc1.type = "triangle";
    osc2.type = "sine";
    osc1.frequency.value = midiToFreq(midi);
    osc2.frequency.value = midiToFreq(midi) * 2;
    osc2.detune.value = 4;
    filter.type = "lowpass";
    filter.frequency.value = 5000;

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.08, velocity / 160), now + 0.02);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(state.masterGain);

    osc1.start();
    osc2.start();

    state.voices.set(midi, { osc1, osc2, gain });
  }

  function noteOff(midi) {
    const ctx = state.audioContext;
    const voice = state.voices.get(midi);
    if (!ctx || !voice) return;

    const now = ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(0.1, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    voice.osc1.stop(now + 0.18);
    voice.osc2.stop(now + 0.18);
    state.voices.delete(midi);
  }

  function stopAllAudio() {
    Array.from(state.voices.keys()).forEach(noteOff);
  }

  function recordEvent(event) {
    if (!state.isRecording) return;
    state.recordedEvents.push({
      ...event,
      time: performance.now() - state.recordingStart,
    });
    updateStats();
  }

  async function handleInputNoteOn(midi, velocity = 100, source = "midi") {
    await noteOn(midi, velocity);
    state.heldKeys.add(midi);
    state.lastNote = midi;
    state.lastVelocity = velocity;
    recordEvent({ type: "on", note: midi, velocity, source });
    updateUI();
  }

  function handleInputNoteOff(midi, source = "midi") {
    noteOff(midi);
    state.heldKeys.delete(midi);
    recordEvent({ type: "off", note: midi, source });
    updateUI();
  }

  function createPiano() {
    const whites = [];
    const blacks = [];
    let whiteIndex = 0;

    for (let midi = KEYBOARD_START; midi <= KEYBOARD_END; midi += 1) {
      if (isBlackKey(midi)) {
        blacks.push({ midi, whiteIndex: whiteIndex - 1 });
      } else {
        whites.push({ midi, whiteIndex });
        whiteIndex += 1;
      }
    }

    const whiteWidth = PIANO_WIDTH / whiteIndex;
    const blackWidth = whiteWidth * 0.62;

    for (const key of whites) {
      const button = document.createElement("button");
      button.className = "key white";
      button.style.left = `${key.whiteIndex * whiteWidth}px`;
      button.style.width = `${whiteWidth}px`;
      button.dataset.midi = String(key.midi);
      button.innerHTML = `<span class="key-label">${key.midi % 12 === 0 ? noteNameFromMidi(key.midi) : ""}</span>`;
      bindPianoInteractions(button, key.midi);
      els.piano.appendChild(button);
    }

    for (const key of blacks) {
      const button = document.createElement("button");
      button.className = "key black";
      button.style.left = `${(key.whiteIndex + 1) * whiteWidth - blackWidth / 2}px`;
      button.style.width = `${blackWidth}px`;
      button.dataset.midi = String(key.midi);
      bindPianoInteractions(button, key.midi);
      els.piano.appendChild(button);
    }
  }

  function bindPianoInteractions(button, midi) {
    button.addEventListener("mousedown", () => handleInputNoteOn(midi, 100, "mouse"));
    button.addEventListener("mouseup", () => handleInputNoteOff(midi, "mouse"));
    button.addEventListener("mouseleave", () => {
      if (state.heldKeys.has(midi)) handleInputNoteOff(midi, "mouse");
    });
    button.addEventListener("touchstart", (event) => {
      event.preventDefault();
      handleInputNoteOn(midi, 100, "touch");
    }, { passive: false });
    button.addEventListener("touchend", () => handleInputNoteOff(midi, "touch"));
  }

  function createChordGrid() {
    PRESET_CHORDS.forEach((chord) => {
      const button = document.createElement("button");
      button.className = "chord-btn";
      button.dataset.chordId = chord.id;
      button.innerHTML = `
        <span class="chord-name">${chord.name}</span>
        <span class="chord-intervals">${chord.intervals.map((n) => `+${n}`).join(" ")}</span>
      `;

      button.addEventListener("click", () => {
        if (state.lastNote == null) return;
        state.selectedChordId = chord.id;
        updateUI();
      });

      const previewStart = async (event) => {
        if (state.lastNote == null) return;
        if (event) event.preventDefault();
        state.previewChordId = chord.id;
        const notes = getChordNotes(state.lastNote, chord);
        notes.forEach((midi) => noteOn(midi, 96));
        if (state.previewTimeout) clearTimeout(state.previewTimeout);
        state.previewTimeout = window.setTimeout(() => {
          notes.forEach(noteOff);
          state.previewChordId = null;
          updateUI();
        }, state.previewMs);
        updateUI();
      };

      const previewEnd = () => {
        const active = state.previewChordId === chord.id ? chord : null;
        if (active && state.lastNote != null) {
          getChordNotes(state.lastNote, active).forEach(noteOff);
        }
        if (state.previewTimeout) clearTimeout(state.previewTimeout);
        state.previewChordId = null;
        updateUI();
      };

      button.addEventListener("mousedown", previewStart);
      button.addEventListener("mouseup", previewEnd);
      button.addEventListener("mouseleave", previewEnd);
      button.addEventListener("touchstart", previewStart, { passive: false });
      button.addEventListener("touchend", previewEnd);

      els.chordGrid.appendChild(button);
    });
  }

  function updatePiano() {
    const highlighted = new Set(getHighlightedNotes());
    const keys = els.piano.querySelectorAll(".key");
    keys.forEach((key) => {
      const midi = Number(key.dataset.midi);
      key.classList.toggle("pressed", state.heldKeys.has(midi));
      key.classList.toggle("chord", highlighted.has(midi));
      key.classList.toggle("root", state.lastNote === midi);
      key.title = `${noteNameFromMidi(midi)} (${midi})`;
    });
  }

  function updateChordGrid() {
    const disabled = state.lastNote == null;
    els.chordGrid.querySelectorAll(".chord-btn").forEach((button) => {
      const chordId = button.dataset.chordId;
      button.disabled = disabled;
      button.classList.toggle("active", chordId === state.selectedChordId || chordId === state.previewChordId);
    });
  }

  function updateStats() {
    els.lastNote.textContent = state.lastNote != null ? noteNameFromMidi(state.lastNote) : "—";
    els.lastMidi.textContent = `MIDI ${state.lastNote != null ? state.lastNote : "—"}`;
    els.lastVelocity.textContent = state.lastVelocity || "—";
    els.inputName.textContent = state.midiInputs[0]?.name || "Browser / mouse";
    els.eventCount.textContent = `${state.recordedEvents.length} events captured`;
    const activeChord = getActiveChord();
    els.selectedChordLabel.textContent = state.lastNote != null && activeChord ? `${pitchClassName(state.lastNote)} ${activeChord.name}` : "—";
    els.recordingBadge.textContent = state.isRecording ? "Recording" : "Idle";
    els.noteSummary.textContent = state.lastNote != null ? `Showing ${noteNameFromMidi(state.lastNote)} and related chord shapes` : "Waiting for input";
  }

  function updateUI() {
    updatePiano();
    updateChordGrid();
    updateStats();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function encodeVariableLength(value) {
    let buffer = value & 0x7f;
    const bytes = [];
    while ((value >>= 7)) {
      buffer <<= 8;
      buffer |= (value & 0x7f) | 0x80;
    }
    while (true) {
      bytes.push(buffer & 0xff);
      if (buffer & 0x80) buffer >>= 8;
      else break;
    }
    return bytes;
  }

  function strBytes(text) {
    return [...text].map((char) => char.charCodeAt(0));
  }

  function numBytes(num, byteCount) {
    const out = new Array(byteCount).fill(0);
    for (let i = byteCount - 1; i >= 0; i -= 1) {
      out[i] = num & 0xff;
      num >>= 8;
    }
    return out;
  }

  function createMidiFile(recordedEvents) {
    const ticksPerQuarter = 480;
    const tempo = 500000;
    const msPerTick = tempo / 1000 / ticksPerQuarter;
    const sorted = [...recordedEvents].sort((a, b) => a.time - b.time);
    const track = [];
    let lastTick = 0;

    track.push(...encodeVariableLength(0), 0xff, 0x51, 0x03, ...numBytes(tempo, 3));

    sorted.forEach((event) => {
      const tick = Math.max(0, Math.round(event.time / msPerTick));
      const delta = tick - lastTick;
      lastTick = tick;
      const status = event.type === "on" ? 0x90 : 0x80;
      const velocity = event.type === "on" ? Math.max(1, Math.min(127, event.velocity || 100)) : 0;
      track.push(...encodeVariableLength(delta), status, event.note, velocity);
    });

    track.push(...encodeVariableLength(0), 0xff, 0x2f, 0x00);

    return new Uint8Array([
      ...strBytes("MThd"),
      ...numBytes(6, 4),
      ...numBytes(0, 2),
      ...numBytes(1, 2),
      ...numBytes(ticksPerQuarter, 2),
      ...strBytes("MTrk"),
      ...numBytes(track.length, 4),
      ...track,
    ]);
  }

  function writeString(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function audioBufferToWav(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const bitsPerSample = 16;
    const blockAlign = channels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioBuffer.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let c = 0; c < channels; c += 1) channelData.push(audioBuffer.getChannelData(c));

    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function renderRecordingToWav(recordedEvents) {
    if (!recordedEvents.length) throw new Error("No recording available.");
    const sorted = [...recordedEvents].sort((a, b) => a.time - b.time);
    const durationMs = Math.max(2000, sorted[sorted.length - 1].time + 2000);
    const sampleRate = 44100;
    const frameCount = Math.ceil((durationMs / 1000) * sampleRate);
    const context = new OfflineAudioContext(2, frameCount, sampleRate);
    const master = context.createGain();
    master.gain.value = 0.92;
    master.connect(context.destination);
    const active = new Map();

    sorted.forEach((event) => {
      const t = event.time / 1000;
      if (event.type === "on") {
        const osc1 = context.createOscillator();
        const osc2 = context.createOscillator();
        const gain = context.createGain();
        const filter = context.createBiquadFilter();
        osc1.type = "triangle";
        osc2.type = "sine";
        osc1.frequency.setValueAtTime(midiToFreq(event.note), t);
        osc2.frequency.setValueAtTime(midiToFreq(event.note) * 2, t);
        osc2.detune.value = 4;
        filter.type = "lowpass";
        filter.frequency.value = 5000;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime((event.velocity || 100) / 180, t + 0.02);
        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        osc1.start(t);
        osc2.start(t);
        active.set(event.note, { osc1, osc2, gain });
      } else {
        const voice = active.get(event.note);
        if (!voice) return;
        voice.gain.gain.cancelScheduledValues(t);
        voice.gain.gain.setValueAtTime(0.1, t);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        voice.osc1.stop(t + 0.2);
        voice.osc2.stop(t + 0.2);
        active.delete(event.note);
      }
    });

    const endTime = durationMs / 1000;
    active.forEach((voice) => {
      voice.gain.gain.setValueAtTime(0.08, Math.max(0, endTime - 0.2));
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, endTime);
      voice.osc1.stop(endTime);
      voice.osc2.stop(endTime);
    });

    const rendered = await context.startRendering();
    return audioBufferToWav(rendered);
  }

  async function setupMIDI() {
    if (!navigator.requestMIDIAccess) {
      els.midiStatus.textContent = "Web MIDI unavailable";
      els.browserStatus.textContent = "Use Chrome or Edge desktop for MIDI";
      return;
    }

    try {
      state.midiAccess = await navigator.requestMIDIAccess();
      bindMidiInputs();
      state.midiAccess.onstatechange = bindMidiInputs;
    } catch (error) {
      els.midiStatus.textContent = "MIDI access denied";
      els.browserStatus.textContent = error.message;
    }
  }

  function bindMidiInputs() {
    const inputs = [...state.midiAccess.inputs.values()];
    state.midiInputs = inputs;
    els.midiStatus.textContent = inputs.length ? `${inputs.length} MIDI input${inputs.length > 1 ? "s" : ""} connected` : "MIDI enabled, no device connected yet";
    els.browserStatus.textContent = "Static GitHub Pages app";

    inputs.forEach((input) => {
      input.onmidimessage = (event) => {
        const [status, data1, data2] = event.data;
        const command = status & 0xf0;
        const note = data1;
        const velocity = data2 || 0;
        if (command === 0x90 && velocity > 0) handleInputNoteOn(note, velocity, "midi");
        else if (command === 0x80 || (command === 0x90 && velocity === 0)) handleInputNoteOff(note, "midi");
      };
    });

    updateStats();
  }

  function wireControls() {
    els.volumeSlider.addEventListener("input", () => {
      state.volume = Number(els.volumeSlider.value);
      if (state.masterGain) state.masterGain.gain.value = state.volume;
    });

    els.previewMsSlider.addEventListener("input", () => {
      state.previewMs = Number(els.previewMsSlider.value);
    });

    els.recordBtn.addEventListener("click", async () => {
      await ensureAudio();
      state.recordedEvents = [];
      state.recordingStart = performance.now();
      state.isRecording = true;
      updateUI();
    });

    els.stopBtn.addEventListener("click", () => {
      state.isRecording = false;
      updateUI();
    });

    els.saveMidiBtn.addEventListener("click", () => {
      if (!state.recordedEvents.length) return;
      const midiBytes = createMidiFile(state.recordedEvents);
      downloadBlob(new Blob([midiBytes], { type: "audio/midi" }), `ius-midi-chord-piano-${Date.now()}.mid`);
    });

    els.saveWavBtn.addEventListener("click", async () => {
      if (!state.recordedEvents.length) return;
      els.browserStatus.textContent = "Rendering WAV…";
      const wavBlob = await renderRecordingToWav(state.recordedEvents);
      downloadBlob(wavBlob, `ius-midi-chord-piano-${Date.now()}.wav`);
      els.browserStatus.textContent = "Static GitHub Pages app";
    });
  }

  function init() {
    createPiano();
    createChordGrid();
    wireControls();
    updateUI();
    setupMIDI();
    window.addEventListener("beforeunload", stopAllAudio);
  }

  init();
})();
