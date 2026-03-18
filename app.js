(() => {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
  const KEYBOARD_START = 21;  // A0
  const KEYBOARD_END = 108;   // C8
  const PIANO_WIDTH = 2520;
  const DEFAULT_PREVIEW_MS = 1200;
  const ROOT_OCTAVE = 4;

  const CHORDS = [
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
    heldKeys: new Set(),
    selectedRootPc: null,
    selectedRootMidi: null,
    selectedChordId: "maj",
    previewChordId: null,
    previewTimer: null,
    audioContext: null,
    masterGain: null,
    voices: new Map(),
    volume: 0.65,
    previewMs: DEFAULT_PREVIEW_MS,
    lastPlayedNote: null,
    lastVelocity: 0,
    midiInputNames: [],
    isRecording: false,
    recordingStart: 0,
    recordedEvents: [],
  };

  const els = {
    browserStatus: document.getElementById("browserStatus"),
    midiStatus: document.getElementById("midiStatus"),
    rootValue: document.getElementById("rootValue"),
    rootHelp: document.getElementById("rootHelp"),
    lastNoteValue: document.getElementById("lastNoteValue"),
    lastMidiValue: document.getElementById("lastMidiValue"),
    selectedChordValue: document.getElementById("selectedChordValue"),
    selectedChordNotes: document.getElementById("selectedChordNotes"),
    recordingValue: document.getElementById("recordingValue"),
    eventCountValue: document.getElementById("eventCountValue"),
    volumeSlider: document.getElementById("volumeSlider"),
    volumeValue: document.getElementById("volumeValue"),
    previewMsSlider: document.getElementById("previewMsSlider"),
    previewMsValue: document.getElementById("previewMsValue"),
    rootRow: document.getElementById("rootRow"),
    chordGrid: document.getElementById("chordGrid"),
    recordBtn: document.getElementById("recordBtn"),
    stopBtn: document.getElementById("stopBtn"),
    saveMidiBtn: document.getElementById("saveMidiBtn"),
    saveWavBtn: document.getElementById("saveWavBtn"),
    piano: document.getElementById("piano"),
    pianoSummary: document.getElementById("pianoSummary"),
    pressedNotesText: document.getElementById("pressedNotesText"),
    chordNotesText: document.getElementById("chordNotesText"),
    midiDeviceText: document.getElementById("midiDeviceText"),
  };

  function isBlackKey(midi) {
    return BLACK_PCS.has(((midi % 12) + 12) % 12);
  }

  function pitchClass(midi) {
    return ((midi % 12) + 12) % 12;
  }

  function noteNameFromMidi(midi) {
    const pc = pitchClass(midi);
    const octave = Math.floor(midi / 12) - 1;
    return `${NOTE_NAMES[pc]}${octave}`;
  }

  function pcName(pc) {
    return NOTE_NAMES[((pc % 12) + 12) % 12];
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function rootPcToMidi(pc, octave = ROOT_OCTAVE) {
    return 12 * (octave + 1) + pc;
  }

  function clampMidi(midi) {
    return Math.max(KEYBOARD_START, Math.min(KEYBOARD_END, midi));
  }

  function getSelectedChord() {
    const id = state.previewChordId || state.selectedChordId;
    return CHORDS.find((chord) => chord.id === id) || null;
  }

  function getRootMidiForDisplay() {
    if (state.selectedRootMidi != null) return state.selectedRootMidi;
    if (state.selectedRootPc != null) return rootPcToMidi(state.selectedRootPc);
    return null;
  }

  function setRootFromMidi(midi) {
    state.selectedRootMidi = midi;
    state.selectedRootPc = pitchClass(midi);
  }

  function setRootFromPitchClass(pc) {
    state.selectedRootPc = pc;
    const current = getRootMidiForDisplay();
    const base = rootPcToMidi(pc);
    if (current == null) {
      state.selectedRootMidi = base;
      return;
    }
    const targetOctave = Math.floor(current / 12) - 1;
    let candidate = rootPcToMidi(pc, targetOctave);
    while (candidate < KEYBOARD_START) candidate += 12;
    while (candidate > KEYBOARD_END) candidate -= 12;
    state.selectedRootMidi = candidate;
  }

  function getChordNotes(rootMidi, chord) {
    const raw = chord.intervals.map((interval) => rootMidi + interval).filter((m) => m >= KEYBOARD_START && m <= KEYBOARD_END);
    if (!raw.length) return [clampMidi(rootMidi)];
    return raw;
  }

  function getDisplayedChordNotes() {
    const root = getRootMidiForDisplay();
    const chord = getSelectedChord();
    if (root == null || !chord) return [];
    return getChordNotes(root, chord);
  }

  async function ensureAudio() {
    if (!state.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new AudioCtx();
      state.masterGain = state.audioContext.createGain();
      state.masterGain.gain.value = state.volume;
      state.masterGain.connect(state.audioContext.destination);
    }
    if (state.audioContext.state === "suspended") await state.audioContext.resume();
    state.masterGain.gain.value = state.volume;
    return state.audioContext;
  }

  async function startVoice(midi, velocity = 100) {
    const ctx = await ensureAudio();
    if (state.voices.has(midi)) return;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc1.type = "triangle";
    osc2.type = "sine";
    osc1.frequency.value = midiToFreq(midi);
    osc2.frequency.value = midiToFreq(midi) * 2;
    osc2.detune.value = 3;
    filter.type = "lowpass";
    filter.frequency.value = 4300;

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.08, Math.min(0.9, velocity / 150)), now + 0.02);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(state.masterGain);

    osc1.start(now);
    osc2.start(now);
    state.voices.set(midi, { osc1, osc2, gain });
  }

  function stopVoice(midi) {
    const ctx = state.audioContext;
    const voice = state.voices.get(midi);
    if (!ctx || !voice) return;
    const now = ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(0.08, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    voice.osc1.stop(now + 0.2);
    voice.osc2.stop(now + 0.2);
    state.voices.delete(midi);
  }

  function stopAllVoices() {
    [...state.voices.keys()].forEach(stopVoice);
  }

  function recordEvent(event) {
    if (!state.isRecording) return;
    state.recordedEvents.push({ ...event, time: performance.now() - state.recordingStart });
  }

  async function handleNoteOn(midi, velocity = 100, source = "midi") {
    setRootFromMidi(midi);
    state.lastPlayedNote = midi;
    state.lastVelocity = velocity;
    state.heldKeys.add(midi);
    await startVoice(midi, velocity);
    recordEvent({ type: "on", note: midi, velocity, source });
    render();
  }

  function handleNoteOff(midi, source = "midi") {
    state.heldKeys.delete(midi);
    stopVoice(midi);
    recordEvent({ type: "off", note: midi, source });
    render();
  }

  function buildRootRow() {
    NOTE_NAMES.forEach((name, pc) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.textContent = name;
      button.dataset.pc = String(pc);
      button.addEventListener("click", async () => {
        setRootFromPitchClass(pc);
        const root = getRootMidiForDisplay();
        if (root != null) {
          await startVoice(root, 100);
          window.setTimeout(() => stopVoice(root), 260);
        }
        render();
      });
      els.rootRow.appendChild(button);
    });
  }

  function previewChordStart(chordId) {
    const chord = CHORDS.find((item) => item.id === chordId);
    const root = getRootMidiForDisplay();
    if (!chord || root == null) return;
    state.previewChordId = chordId;
    const notes = getChordNotes(root, chord);
    notes.forEach((midi) => startVoice(midi, 92));
    if (state.previewTimer) clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => previewChordEnd(chordId), state.previewMs);
    render();
  }

  function previewChordEnd(chordId) {
    const activeId = state.previewChordId;
    if (state.previewTimer) clearTimeout(state.previewTimer);
    state.previewTimer = null;
    if (activeId && (!chordId || chordId === activeId)) {
      const chord = CHORDS.find((item) => item.id === activeId);
      const root = getRootMidiForDisplay();
      if (chord && root != null) getChordNotes(root, chord).forEach(stopVoice);
    }
    state.previewChordId = null;
    render();
  }

  function buildChordGrid() {
    CHORDS.forEach((chord) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chord-card";
      button.dataset.chordId = chord.id;
      button.innerHTML = `<span class="chord-name">${chord.name}</span><span class="chord-meta">${chord.intervals.map((n) => `+${n}`).join(" ")}</span>`;

      button.addEventListener("click", () => {
        state.selectedChordId = chord.id;
        render();
      });

      const start = (event) => {
        if (event) event.preventDefault();
        previewChordStart(chord.id);
      };
      const end = () => previewChordEnd(chord.id);

      button.addEventListener("mousedown", start);
      button.addEventListener("mouseup", end);
      button.addEventListener("mouseleave", end);
      button.addEventListener("touchstart", start, { passive: false });
      button.addEventListener("touchend", end);
      button.addEventListener("touchcancel", end);
      els.chordGrid.appendChild(button);
    });
  }

  function buildPiano() {
    const whites = [];
    const blacks = [];
    let whiteIndex = 0;

    for (let midi = KEYBOARD_START; midi <= KEYBOARD_END; midi += 1) {
      if (isBlackKey(midi)) blacks.push({ midi, whiteIndex: whiteIndex - 1 });
      else {
        whites.push({ midi, whiteIndex });
        whiteIndex += 1;
      }
    }

    const whiteWidth = PIANO_WIDTH / whiteIndex;
    const blackWidth = whiteWidth * 0.63;

    function bindKey(button, midi) {
      button.dataset.midi = String(midi);
      button.title = `${noteNameFromMidi(midi)} (${midi})`;
      button.addEventListener("mousedown", () => handleNoteOn(midi, 100, "mouse"));
      button.addEventListener("mouseup", () => handleNoteOff(midi, "mouse"));
      button.addEventListener("mouseleave", () => {
        if (state.heldKeys.has(midi)) handleNoteOff(midi, "mouse");
      });
      button.addEventListener("touchstart", (event) => {
        event.preventDefault();
        handleNoteOn(midi, 100, "touch");
      }, { passive: false });
      button.addEventListener("touchend", () => handleNoteOff(midi, "touch"));
      button.addEventListener("touchcancel", () => handleNoteOff(midi, "touch"));
    }

    whites.forEach((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "key white";
      button.style.left = `${key.whiteIndex * whiteWidth}px`;
      button.style.width = `${whiteWidth}px`;
      button.innerHTML = `<span class="key-label">${pitchClass(key.midi) === 0 ? noteNameFromMidi(key.midi) : ""}</span>`;
      bindKey(button, key.midi);
      els.piano.appendChild(button);
    });

    blacks.forEach((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "key black";
      button.style.left = `${(key.whiteIndex + 1) * whiteWidth - blackWidth / 2}px`;
      button.style.width = `${blackWidth}px`;
      bindKey(button, key.midi);
      els.piano.appendChild(button);
    });
  }

  function updateRootButtons() {
    const selectedPc = state.selectedRootPc;
    els.rootRow.querySelectorAll(".chip").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.pc) === selectedPc);
    });
  }

  function updateChordButtons() {
    const selected = state.selectedChordId;
    const preview = state.previewChordId;
    const rootAvailable = getRootMidiForDisplay() != null;
    els.chordGrid.querySelectorAll(".chord-card").forEach((button) => {
      const id = button.dataset.chordId;
      button.disabled = !rootAvailable;
      button.classList.toggle("active", id === selected || id === preview);
    });
  }

  function updatePiano() {
    const highlighted = new Set(getDisplayedChordNotes());
    const root = getRootMidiForDisplay();
    els.piano.querySelectorAll(".key").forEach((button) => {
      const midi = Number(button.dataset.midi);
      button.classList.toggle("pressed", state.heldKeys.has(midi));
      button.classList.toggle("chord", highlighted.has(midi));
      button.classList.toggle("root", midi === root);
    });
  }

  function updateText() {
    const root = getRootMidiForDisplay();
    const chord = getSelectedChord();
    const chordNotes = getDisplayedChordNotes();
    const pressed = [...state.heldKeys].sort((a, b) => a - b);

    els.rootValue.textContent = root != null ? noteNameFromMidi(root) : "—";
    els.rootHelp.textContent = root != null ? `Root pitch class ${pcName(pitchClass(root))}` : "Play or click a note, or choose from the root row.";
    els.lastNoteValue.textContent = state.lastPlayedNote != null ? noteNameFromMidi(state.lastPlayedNote) : "—";
    els.lastMidiValue.textContent = `MIDI ${state.lastPlayedNote != null ? state.lastPlayedNote : "—"}${state.lastPlayedNote != null ? ` • velocity ${state.lastVelocity}` : ""}`;
    els.selectedChordValue.textContent = root != null && chord ? `${pcName(pitchClass(root))} ${chord.name}` : "—";
    els.selectedChordNotes.textContent = chordNotes.length ? chordNotes.map(noteNameFromMidi).join(" · ") : "Choose a root and chord type.";
    els.recordingValue.textContent = state.isRecording ? "Recording" : "Idle";
    els.eventCountValue.textContent = `${state.recordedEvents.length} events captured`;
    els.volumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    els.previewMsValue.textContent = `${state.previewMs} ms`;
    els.pressedNotesText.textContent = pressed.length ? pressed.map(noteNameFromMidi).join(" · ") : "None";
    els.chordNotesText.textContent = chordNotes.length ? chordNotes.map((m) => `${noteNameFromMidi(m)} (${m})`).join(" · ") : "None";
    els.midiDeviceText.textContent = state.midiInputNames.length ? state.midiInputNames.join(", ") : "Browser / mouse / touch";
    els.pianoSummary.textContent = root != null && chord ? `Blue = currently pressed notes, red = ${pcName(pitchClass(root))} ${chord.name}, soft white ring = selected root.` : "Blue = currently pressed notes, red = chord shape, soft white ring = selected root.";
    els.recordBtn.textContent = state.isRecording ? "Recording…" : "Record";
    els.stopBtn.disabled = !state.isRecording;
    els.saveMidiBtn.disabled = !state.recordedEvents.length;
    els.saveWavBtn.disabled = !state.recordedEvents.length;
  }

  function render() {
    updateRootButtons();
    updateChordButtons();
    updatePiano();
    updateText();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
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

  function createMidiFile(events) {
    const ticksPerQuarter = 480;
    const tempo = 500000;
    const msPerTick = tempo / 1000 / ticksPerQuarter;
    const sorted = [...events].sort((a, b) => a.time - b.time);
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

  async function renderRecordingToWav(events) {
    if (!events.length) throw new Error("No recording available.");
    const sorted = [...events].sort((a, b) => a.time - b.time);
    const durationMs = Math.max(2200, sorted[sorted.length - 1].time + 2000);
    const sampleRate = 44100;
    const frameCount = Math.ceil((durationMs / 1000) * sampleRate);
    const context = new OfflineAudioContext(2, frameCount, sampleRate);
    const master = context.createGain();
    master.gain.value = 0.96;
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
        osc2.detune.value = 3;
        filter.type = "lowpass";
        filter.frequency.value = 4300;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.08, Math.min(0.9, (event.velocity || 100) / 150)), t + 0.02);
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
        voice.gain.gain.setValueAtTime(0.08, t);
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

    return audioBufferToWav(await context.startRendering());
  }

  async function setupMIDI() {
    if (!navigator.requestMIDIAccess) {
      els.browserStatus.textContent = "Web MIDI is not available in this browser";
      els.midiStatus.textContent = "Use Chrome or Edge on desktop for hardware MIDI";
      render();
      return;
    }

    els.browserStatus.textContent = "Web MIDI available";
    try {
      state.midiAccess = await navigator.requestMIDIAccess();
      const bindInputs = () => {
        const inputs = [...state.midiAccess.inputs.values()];
        state.midiInputNames = inputs.map((input) => input.name || "Unnamed MIDI device");
        els.midiStatus.textContent = inputs.length ? `Connected to ${inputs.length} MIDI input${inputs.length > 1 ? "s" : ""}` : "MIDI enabled — connect a keyboard and press a note";
        inputs.forEach((input) => {
          input.onmidimessage = (event) => {
            const [status, note, velocity = 0] = event.data;
            const command = status & 0xf0;
            if (command === 0x90 && velocity > 0) handleNoteOn(note, velocity, "midi");
            else if (command === 0x80 || (command === 0x90 && velocity === 0)) handleNoteOff(note, "midi");
          };
        });
        render();
      };
      bindInputs();
      state.midiAccess.onstatechange = bindInputs;
    } catch (error) {
      els.midiStatus.textContent = `MIDI access failed: ${error.message}`;
      render();
    }
  }

  function bindControls() {
    els.volumeSlider.addEventListener("input", () => {
      state.volume = Number(els.volumeSlider.value);
      if (state.masterGain) state.masterGain.gain.value = state.volume;
      render();
    });

    els.previewMsSlider.addEventListener("input", () => {
      state.previewMs = Number(els.previewMsSlider.value);
      render();
    });

    els.recordBtn.addEventListener("click", async () => {
      await ensureAudio();
      state.recordedEvents = [];
      state.recordingStart = performance.now();
      state.isRecording = true;
      render();
    });

    els.stopBtn.addEventListener("click", () => {
      state.isRecording = false;
      render();
    });

    els.saveMidiBtn.addEventListener("click", () => {
      if (!state.recordedEvents.length) return;
      downloadBlob(new Blob([createMidiFile(state.recordedEvents)], { type: "audio/midi" }), `ius-midi-chord-piano-${Date.now()}.mid`);
    });

    els.saveWavBtn.addEventListener("click", async () => {
      if (!state.recordedEvents.length) return;
      els.saveWavBtn.disabled = true;
      const old = els.saveWavBtn.textContent;
      els.saveWavBtn.textContent = "Rendering WAV…";
      try {
        const wav = await renderRecordingToWav(state.recordedEvents);
        downloadBlob(wav, `ius-midi-chord-piano-${Date.now()}.wav`);
      } finally {
        els.saveWavBtn.textContent = old;
        els.saveWavBtn.disabled = false;
        render();
      }
    });
  }

  function exposeForTests() {
    window.IUSChordPiano = {
      state,
      setRootFromPitchClass,
      previewChordStart,
      previewChordEnd,
      getDisplayedChordNotes,
      getSelectedChord,
      handleNoteOn,
      handleNoteOff,
      render,
      noteNameFromMidi,
      createMidiFile,
    };
  }


  async function maybeRunSelfTest() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("selftest") !== "1") return;
    const results = [];
    try {
      setRootFromPitchClass(0);
      render();
      results.push(state.selectedRootPc === 0 ? "root-select:ok" : "root-select:fail");

      state.selectedChordId = "maj7";
      render();
      const notes = getDisplayedChordNotes().map(noteNameFromMidi).join(",");
      results.push(notes.includes("C4") && notes.includes("E4") && notes.includes("G4") && notes.includes("B4") ? "chord-notes:ok" : `chord-notes:fail:${notes}`);

      await handleNoteOn(62, 100, "selftest");
      const pressedAfterOn = state.heldKeys.has(62);
      handleNoteOff(62, "selftest");
      const pressedAfterOff = state.heldKeys.has(62);
      results.push(pressedAfterOn && !pressedAfterOff ? "note-io:ok" : "note-io:fail");

      state.recordedEvents = [
        { type: "on", note: 60, velocity: 100, time: 0 },
        { type: "off", note: 60, time: 400 },
      ];
      const midiBytes = createMidiFile(state.recordedEvents);
      results.push(midiBytes.length > 20 ? "midi-export:ok" : "midi-export:fail");

      const ok = results.every((item) => item.endsWith(":ok"));
      document.body.setAttribute("data-selftest", ok ? "pass" : "fail");
      const marker = document.createElement("pre");
      marker.id = "selftest-results";
      marker.textContent = results.join("\n");
      document.body.appendChild(marker);
    } catch (error) {
      document.body.setAttribute("data-selftest", "fail");
      const marker = document.createElement("pre");
      marker.id = "selftest-results";
      marker.textContent = `error:${error.message}`;
      document.body.appendChild(marker);
    }
  }

  function init() {
    buildRootRow();
    buildChordGrid();
    buildPiano();
    bindControls();
    exposeForTests();
    render();
    setupMIDI();
    maybeRunSelfTest();
  }

  init();
})();
