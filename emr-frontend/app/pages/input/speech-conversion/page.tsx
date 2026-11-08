'use client';

import {useState, useRef} from 'react';

// Convert the recording into a WAV file
async function toWav(audio: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    const samples = decoded.length;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);

    const writeText = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    };

    // Write the WAV file header
    writeText(0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, decoded.sampleRate, true);
    view.setUint32(28, decoded.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples * 2, true);

    // Save the recorded sound as WAV audio
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    for (let i = 0; i < samples; i++) {
      const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally {
    await context.close();
  }
}

export default function SpeechConversion() {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const wanted = useRef(false);
  const busy = useRef(false);

  // Post the recording to Whisper through the local whisper call
  const transcribe = async (audio: Blob) => {
    const form = new FormData();
    form.append('file', audio, 'recording.wav');
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    const response = await fetch('/api/v1/audio/transcriptions', {
      method: 'POST', body: form,
    });
    if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${await response.text()}`);
    const result = await response.text();
    setText(result);
  };

  // Allow user to stop the recorder
  const stopRecording = () => {
    wanted.current = false;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
  };

  // Request microphone access and start audio
  const startRecording = async () => {
    if (busy.current || wanted.current) return;
    wanted.current = true;
    busy.current = true;
    setError(null);
    setStatus('requesting');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Microphone recording requires a supported browser on localhost or HTTPS.');
      }
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = microphone;
      const activeRecorder = new MediaRecorder(microphone);
      recorder.current = activeRecorder;
      const chunks: Blob[] = [];
      activeRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };

      // Convert the audio to the transcript
      activeRecorder.onstop = async () => {
        wanted.current = false;
        microphone.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        stream.current = null;
        setStatus('transcribing');
        try {
          if (!chunks.length) throw new Error('No audio recorded. Start recording and speak before stopping.');
          const wav = await toWav(new Blob(chunks, { type: activeRecorder.mimeType }));
          await transcribe(wav);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not process recording');
        } finally {
          busy.current = false;
          setStatus('idle');
        }
      };
      activeRecorder.onerror = () => {
        activeRecorder.onstop = null;
        stopRecording();
        busy.current = false;
        setError('Microphone recording failed. Please try again.');
        setStatus('idle');
      };
      activeRecorder.start();
      setStatus('recording');
    } catch (err) {
      wanted.current = false;
      busy.current = false;
      stream.current?.getTracks().forEach((track) => track.stop());
      setError(err instanceof Error ? err.message : 'Could not access microphone');
      setStatus('idle');
    }
  };

  const active = status === 'requesting' || status === 'recording';
  return (
    <main className="ml-56 min-w-0 flex-1 space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Speech Conversion</h1>
      <button type="button" disabled={status === 'transcribing'}
        className="rounded-lg bg-blue-700 px-5 py-3 font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait disabled:opacity-50"
        aria-pressed={active}
        onClick={() => {
          if (wanted.current) stopRecording();
          else void startRecording();
        }}>
        {active ? 'Stop recording' : 'Start recording'}
      </button>
      <p role="status">{status === 'requesting' ? 'Allow microphone access…'
        : status === 'recording' ? 'Recording…'
        : status === 'transcribing' ? 'Transcribing…' : 'Ready'}</p>
      <p>Click the button to start, then click again to stop.</p>
      {error && <p role="alert">{error}</p>}
      <h3>Returned Text: {text}</h3>
    </main>
  );
}
