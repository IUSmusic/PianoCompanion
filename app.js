import { CHORDS, SCALES } from './data/chords.js';

(() => {
  // ==================== 1. CONSTANTS & DATA ====================
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
  const KEYBOARD_START = 36; // C2
  const KEYBOARD_END = 96;   // C7
  const PIANO_WIDTH = 1240;
  const KEYBOARD_SHORTCUT_STEP = 1;

  // ==================== 2. STATE & DOM REFERENCES ====================
  const state = {
    midiAccess: null,
    midiInputs: [],
    heldKeys: new Set(),
    lastNote: null,
    lastVelocity: 0,
    selectedChordId: null,
    selectedScaleId: null,
    previewChordId: null,
    previewScaleId: null,
    previewTimeout: null,
    isRecording: false,
    recordingStart: 0,
    recordedEvents: [],
    volume: 0.6,
    previewMs: 1200,
    audioContext: null,
    masterGain: null,
    voices: new Map(),
    mode: "chords",
    debug: false,
    detectedChordLabel: "—",
    rafPiano: 0,
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
    scaleGrid: document.getElementById("scaleGrid"),
    piano: document.getElementById("piano"),
    noteSummary: document.getElementById("noteSummary"),
    modeButtons: [...document.querySelectorAll("[data-mode]")],
    debugBadge: document.getElementById("debugBadge"),
    detectedChord: document.getElementById("detectedChord"),
    useDetectedChordBtn: document.getElementById("useDetectedChordBtn"),
  };

  // ==================== 3. UTILITIES ====================
  function isBlackKey(midi) {
    return BLACK_PCS.has(((midi % 12) + 12) % 12);
  }

  function noteNameFromMidi(midi) {
    const pc = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return `${NOTE_NAMES[pc]}${octave}`;
  }

  function pitchClass(midi) {
    return ((midi % 12) + 12) % 12;
  }

  function pitchClassName(midi) {
    return NOTE_NAMES[pitchClass(midi)];
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function clampMidi(midi) {
    return Math.max(KEYBOARD_START, Math.min(KEYBOARD_END, midi));
  }

  function debugLog(...args) {
    if (state.debug) console.debug("[I/US MIDI Piano]", ...args);
  }

  function updateStatus(message, tone = "default") {
    els.browserStatus.textContent = message;
    els.browserStatus.dataset.tone = tone;
  }

  function getActiveChord() {
    const id = state.previewChordId || state.selectedChordId;
    return CHORDS.find((chord) => chord.id === id) || null;
  }

  function getActiveScale() {
    const id = state.previewScaleId || state.selectedScaleId;
    return SCALES.find((scale) => scale.id === id) || null;
  }

  function getChordNotes(rootMidi, chord) {
    return chord.intervals.map((interval) => clampMidi(rootMidi + interval));
  }

  function getScaleNotes(rootMidi, scale) {
    return scale.intervals.map((interval) => clampMidi(rootMidi + interval));
  }

  function getDisplayedNotes() {
    if (state.lastNote == null) return [];
    if (state.mode === "scales") {
      const scale = getActiveScale();
      return scale ? getScaleNotes(state.lastNote, scale) : [];
    }
    const chord = getActiveChord();
    return chord ? getChordNotes(state.lastNote, chord) : [];
  }

  function detectChordFromHeld() {
    if (state.heldKeys.size < 3) return null;
    const sorted = [...state.heldKeys].sort((a, b) => a - b);
    const pitchClasses = [...new Set(sorted.map(pitchClass))];

    for (const candidateRoot of pitchClasses) {
      const intervals = pitchClasses
        .map((pc) => (pc - candidateRoot + 12) % 12)
        .sort((a, b) => a - b);
      const match = CHORDS.find((chord) =>
        intervals.length === chord.intervals.length &&
        intervals.every((interval, index) => interval === chord.intervals.slice().sort((a, b) => a - b)[index])
      );
      if (match) {
        return {
          chord: match,
          rootPc: candidateRoot,
          label: `${NOTE_NAMES[candidateRoot]} ${match.name}`,
        };
      }
    }
    return null;
  }

  function schedulePianoUpdate() {
    if (state.rafPiano) return;
    state.rafPiano = window.requestAnimationFrame(() => {
      state.rafPiano = 0;
      renderPianoState();
    });
  }

  function clearPreviewTimer() {
    if (state.previewTimeout) {
      clearTimeout(state.previewTimeout);
      state.previewTimeout = null;
    }
  }

  function releaseAllPreviewNotes(notes) {
    notes.forEach(audio.stopNote);
  }

  // ==================== 4. AUDIO ENGINE ====================
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

  async function playNote(midi, velocity = 100) {
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

    state.voices.set(midi, { osc1, osc2, gain, releaseTimeout: null });
  }

  function stopNote(midi) {
    const ctx = state.audioContext;
    const voice = state.voices.get(midi);
    if (!ctx || !voice) return;

    const now = ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(0.1, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    voice.osc1.stop(now + 0.18);
    voice.osc2.stop(now + 0.18);
    if (voice.releaseTimeout) clearTimeout(voice.releaseTimeout);
    voice.releaseTimeout = window.setTimeout(() => state.voices.delete(midi), 260);
  }

  function stopAllAudio() {
    Array.from(state.voices.keys()).forEach(stopNote);
  }

  async function renderWAV(recordedEvents) {
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

  const audio = { ensureAudio, playNote, stopNote, renderWAV };

  // ==================== 5. MIDI HANDLING ====================
  function recordEvent(event) {
    if (!state.isRecording) return;
    state.recordedEvents.push({
      ...event,
      time: performance.now() - state.recordingStart,
    });
    updateStats();
  }

  async function handleNoteOn(midi, velocity = 100, source = "midi") {
    await audio.playNote(midi, velocity);
    state.heldKeys.add(midi);
    state.lastNote = midi;
    state.lastVelocity = velocity;
    recordEvent({ type: "on", note: midi, velocity, source });
    updateDetectedChord();
    updateUI();
    debugLog("noteOn", { midi, velocity, source, held: [...state.heldKeys].sort((a, b) => a - b) });
  }

  function handleNoteOff(midi, source = "midi") {
    audio.stopNote(midi);
    state.heldKeys.delete(midi);
    recordEvent({ type: "off", note: midi, source });
    updateDetectedChord();
    updateUI();
    debugLog("noteOff", { midi, source, held: [...state.heldKeys].sort((a, b) => a - b) });
  }

  async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      els.midiStatus.textContent = "Web MIDI unavailable";
      updateStatus("Use Chrome or Edge desktop for MIDI", "warn");
      return;
    }

    try {
      state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      bindMidiInputs();
      state.midiAccess.onstatechange = bindMidiInputs;
    } catch (error) {
      els.midiStatus.textContent = "MIDI access denied";
      updateStatus(`MIDI unavailable: ${error.message}`, "error");
    }
  }

  function bindMidiInputs() {
    const inputs = [...state.midiAccess.inputs.values()];
    state.midiInputs = inputs;
    els.midiStatus.textContent = inputs.length ? `${inputs.length} MIDI input${inputs.length > 1 ? "s" : ""} connected` : "MIDI enabled, no device connected yet";
    updateStatus("Static GitHub Pages app");

    inputs.forEach((input) => {
      input.onmidimessage = (event) => {
        const [status, data1, data2] = event.data;
        const command = status & 0xf0;
        const note = data1;
        const velocity = data2 || 0;
        if (command === 0x90 && velocity > 0) handleNoteOn(note, velocity, "midi");
        else if (command === 0x80 || (command === 0x90 && velocity === 0)) handleNoteOff(note, "midi");
      };
    });

    updateStats();
  }

  const midi = { init: initMIDI, handleNoteOn, handleNoteOff };

  // ==================== 6. PIANO RENDERING ====================
  function renderPiano() {
    const whites = [];
    const blacks = [];
    let whiteIndex = 0;

    for (let midiNote = KEYBOARD_START; midiNote <= KEYBOARD_END; midiNote += 1) {
      if (isBlackKey(midiNote)) {
        blacks.push({ midi: midiNote, whiteIndex: whiteIndex - 1 });
      } else {
        whites.push({ midi: midiNote, whiteIndex });
        whiteIndex += 1;
      }
    }

    const whiteWidth = PIANO_WIDTH / whiteIndex;
    const blackWidth = whiteWidth * 0.62;

    const makeKeyButton = (midiNote, className, left, width) => {
      const button = document.createElement("button");
      button.className = `key ${className}`;
      button.type = "button";
      button.style.left = `${left}px`;
      button.style.width = `${width}px`;
      button.dataset.midi = String(midiNote);
      button.dataset.note = noteNameFromMidi(midiNote);
      button.setAttribute("role", "button");
      button.setAttribute("aria-label", `Play ${noteNameFromMidi(midiNote)}`);
      button.tabIndex = 0;

      const label = document.createElement("span");
      label.className = "key-label";
      label.textContent = noteNameFromMidi(midiNote);
      button.appendChild(label);

      const onPress = async (event) => {
        event.preventDefault();
        await midi.handleNoteOn(midiNote, 96, "mouse");
      };
      const onRelease = () => midi.handleNoteOff(midiNote, "mouse");

      button.addEventListener("mousedown", onPress);
      button.addEventListener("mouseup", onRelease);
      button.addEventListener("mouseleave", onRelease);
      button.addEventListener("touchstart", onPress, { passive: false });
      button.addEventListener("touchend", onRelease);
      button.addEventListener("keydown", async (event) => {
        if (event.repeat) return;
        if (event.key === "Enter" || event.key === " ") await onPress(event);
      });
      button.addEventListener("keyup", (event) => {
        if (event.key === "Enter" || event.key === " ") onRelease();
      });

      els.piano.appendChild(button);
    };

    whites.forEach((key) => makeKeyButton(key.midi, "white", key.whiteIndex * whiteWidth, whiteWidth));
    blacks.forEach((key) => makeKeyButton(key.midi, "black", (key.whiteIndex + 1) * whiteWidth - blackWidth / 2, blackWidth));
  }

  function renderPianoState() {
    const highlighted = new Set(getDisplayedNotes());
    const keys = els.piano.querySelectorAll(".key");
    keys.forEach((key) => {
      const midiNote = Number(key.dataset.midi);
      key.classList.toggle("pressed", state.heldKeys.has(midiNote));
      key.classList.toggle("chord", state.mode === "chords" && highlighted.has(midiNote));
      key.classList.toggle("scale", state.mode === "scales" && highlighted.has(midiNote));
      key.classList.toggle("root", state.lastNote === midiNote);
      key.title = `${noteNameFromMidi(midiNote)} (${midiNote})`;
    });
  }

  // ==================== 7. CHORD LOGIC ====================
  function buildChordGrid() {
    els.chordGrid.innerHTML = "";
    CHORDS.forEach((chord) => {
      const button = document.createElement("button");
      button.className = "chord-btn";
      button.type = "button";
      button.dataset.chordId = chord.id;
      button.innerHTML = `<span class="chord-name">${chord.name}</span><span class="chord-intervals">${chord.intervals.join(" • ")}</span>`;

      button.addEventListener("click", () => {
        if (state.lastNote == null) return;
        state.selectedChordId = chord.id;
        state.mode = "chords";
        updateUI();
      });

      const previewStart = async (event) => {
        if (state.lastNote == null) return;
        event?.preventDefault();
        state.mode = "chords";
        state.previewChordId = chord.id;
        const notes = getChordNotes(state.lastNote, chord);
        await Promise.all(notes.map((midiNote) => audio.playNote(midiNote, 96)));
        clearPreviewTimer();
        state.previewTimeout = window.setTimeout(() => {
          releaseAllPreviewNotes(notes);
          state.previewChordId = null;
          updateUI();
        }, state.previewMs);
        debugLog("previewChord", { chord: chord.id, notes });
        updateUI();
      };

      const previewEnd = () => {
        const active = state.previewChordId === chord.id ? chord : null;
        if (active && state.lastNote != null) releaseAllPreviewNotes(getChordNotes(state.lastNote, active));
        clearPreviewTimer();
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

  function buildScaleGrid() {
    els.scaleGrid.innerHTML = "";
    SCALES.forEach((scale) => {
      const button = document.createElement("button");
      button.className = "chord-btn";
      button.type = "button";
      button.dataset.scaleId = scale.id;
      button.innerHTML = `<span class="chord-name">${scale.name}</span><span class="chord-intervals">${scale.intervals.join(" • ")}</span>`;

      button.addEventListener("click", () => {
        if (state.lastNote == null) return;
        state.selectedScaleId = scale.id;
        state.mode = "scales";
        updateUI();
      });

      const previewStart = async (event) => {
        if (state.lastNote == null) return;
        event?.preventDefault();
        state.mode = "scales";
        state.previewScaleId = scale.id;
        const notes = getScaleNotes(state.lastNote, scale);
        await Promise.all(notes.map((midiNote) => audio.playNote(midiNote, 84)));
        clearPreviewTimer();
        state.previewTimeout = window.setTimeout(() => {
          releaseAllPreviewNotes(notes);
          state.previewScaleId = null;
          updateUI();
        }, state.previewMs);
        updateUI();
      };

      const previewEnd = () => {
        const active = state.previewScaleId === scale.id ? scale : null;
        if (active && state.lastNote != null) releaseAllPreviewNotes(getScaleNotes(state.lastNote, active));
        clearPreviewTimer();
        state.previewScaleId = null;
        updateUI();
      };

      button.addEventListener("mousedown", previewStart);
      button.addEventListener("mouseup", previewEnd);
      button.addEventListener("mouseleave", previewEnd);
      button.addEventListener("touchstart", previewStart, { passive: false });
      button.addEventListener("touchend", previewEnd);

      els.scaleGrid.appendChild(button);
    });
  }

  function updateDetectedChord() {
    const detected = detectChordFromHeld();
    state.detectedChordLabel = detected?.label || "—";
    els.useDetectedChordBtn.disabled = !detected;
    els.useDetectedChordBtn.dataset.detectedChordId = detected?.chord.id || "";
    els.useDetectedChordBtn.dataset.detectedRootPc = detected ? String(detected.rootPc) : "";
  }

  // ==================== 8. RECORDING & EXPORT ====================
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

  // ==================== 9. UI BINDINGS & EVENT LISTENERS ====================
  function updateModeButtons() {
    els.modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
      button.setAttribute("aria-pressed", button.dataset.mode === state.mode ? "true" : "false");
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

  function updateScaleGrid() {
    const disabled = state.lastNote == null;
    els.scaleGrid.querySelectorAll(".chord-btn").forEach((button) => {
      const scaleId = button.dataset.scaleId;
      button.disabled = disabled;
      button.classList.toggle("active", scaleId === state.selectedScaleId || scaleId === state.previewScaleId);
    });
  }

  function updateStats() {
    els.lastNote.textContent = state.lastNote != null ? noteNameFromMidi(state.lastNote) : "—";
    els.lastMidi.textContent = `MIDI ${state.lastNote != null ? state.lastNote : "—"}`;
    els.lastVelocity.textContent = state.lastVelocity || "—";
    els.inputName.textContent = state.midiInputs[0]?.name || "Browser / mouse";
    els.eventCount.textContent = `${state.recordedEvents.length} events captured`;
    const activeChord = getActiveChord();
    const activeScale = getActiveScale();
    els.selectedChordLabel.textContent = state.lastNote != null && activeChord
      ? `${pitchClassName(state.lastNote)} ${activeChord.name}`
      : state.lastNote != null && activeScale
        ? `${pitchClassName(state.lastNote)} ${activeScale.name}`
        : "—";
    els.recordingBadge.textContent = state.isRecording ? "Recording" : "Idle";
    els.noteSummary.textContent = state.lastNote != null
      ? `Showing ${noteNameFromMidi(state.lastNote)} with ${state.mode === "chords" ? "chords" : "scales"}`
      : "Waiting for input";
    els.debugBadge.textContent = state.debug ? "Debug on (?)" : "Debug off (?)";
    els.detectedChord.textContent = state.detectedChordLabel;
  }

  function updateUI() {
    schedulePianoUpdate();
    updateChordGrid();
    updateScaleGrid();
    updateModeButtons();
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
      await audio.ensureAudio();
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
      updateStatus("Rendering WAV…", "warn");
      try {
        const wavBlob = await audio.renderWAV(state.recordedEvents);
        downloadBlob(wavBlob, `ius-midi-chord-piano-${Date.now()}.wav`);
        updateStatus("Static GitHub Pages app");
      } catch (error) {
        updateStatus(`WAV render failed: ${error.message}`, "error");
      }
    });

    els.modeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.mode = button.dataset.mode;
        updateUI();
      });
    });

    els.useDetectedChordBtn.addEventListener("click", () => {
      const chordId = els.useDetectedChordBtn.dataset.detectedChordId;
      const rootPc = Number(els.useDetectedChordBtn.dataset.detectedRootPc);
      if (!chordId || Number.isNaN(rootPc)) return;
      state.selectedChordId = chordId;
      state.mode = "chords";
      if (state.lastNote != null) {
        const octaveBase = Math.floor(state.lastNote / 12) * 12;
        state.lastNote = clampMidi(octaveBase + rootPc);
      }
      updateUI();
    });

    document.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(event.target.tagName) && event.target !== document.body) {
        return;
      }
      if (event.key === "?") {
        state.debug = !state.debug;
        updateUI();
        debugLog("debug toggled", state.debug);
      }
      if (event.code === "Space") {
        event.preventDefault();
        state.isRecording = !state.isRecording;
        if (state.isRecording && !state.recordedEvents.length) state.recordingStart = performance.now();
        updateUI();
      }
      if (state.lastNote != null && event.key === "ArrowLeft") {
        event.preventDefault();
        state.lastNote = clampMidi(state.lastNote - KEYBOARD_SHORTCUT_STEP);
        updateUI();
      }
      if (state.lastNote != null && event.key === "ArrowRight") {
        event.preventDefault();
        state.lastNote = clampMidi(state.lastNote + KEYBOARD_SHORTCUT_STEP);
        updateUI();
      }
    });
  }

  const ui = { renderPiano, buildChordGrid, buildScaleGrid, updateStatus };

  function init() {
    ui.renderPiano();
    ui.buildChordGrid();
    ui.buildScaleGrid();
    wireControls();
    updateDetectedChord();
    updateUI();
    midi.init();
    window.addEventListener("beforeunload", stopAllAudio);
  }

  init();
})();
