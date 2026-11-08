"use client";

import { useState, type FormEvent } from "react";
import { useSpeech, useVoices } from "react-text-to-speech";

export default function AudioOutput() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(1);
  const [voiceURI, setVoiceURI] = useState("");
  const [language, setLanguage] = useState("");
  const { voices } = useVoices();
  const languages = [...new Set(voices.map((voice) => voice.lang))].sort();
  const filteredVoices = voices.filter((voice) => !language || voice.lang === language);
  const { speechStatus, start, pause, stop } = useSpeech({
    text,
    rate,
    voiceURI: voiceURI || undefined,
    lang: language || undefined,
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    const formData = new FormData(event.currentTarget);
    stop();
    setText("");
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/gemini/summarize-files", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to summarize the files.");
      }
      if (typeof data.summary !== "string" || !data.summary.trim()) {
        throw new Error("No summary was returned. Please try again.");
      }

      setText(data.summary);

    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to summarize the files.");

    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-3xl bg-white rounded-b-sm border-4 border-slate-400 p-6">
        <h1 className="text-xl font-semibold text-slate-900">File to Audio</h1>
        <p className="mt-1 text-sm text-slate-500">Upload your files to create a summary you can read or listen to.</p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label htmlFor="summary-files" className="block text-sm font-medium text-slate-700">Files to summarize</label>
          <input
            id="summary-files"
            type="file"
            name="myFile"
            accept=".pdf,.txt,.csv,.md,.json,.xml,.cda,.html,.htm,.png,.jpg,.jpeg,.webp"
            multiple
            required
            disabled={loading}
            aria-describedby="summary-file-help"
            className="block w-full rounded-b-sm border-2 border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600 file:mr-3 file:rounded-b-sm file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:font-medium file:text-indigo-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p id="summary-file-help" className="text-xs leading-relaxed text-slate-500">Choose up to 10 PDF, text, CSV, JSON, XML, HTML, Markdown, PNG, JPEG, or WebP files.</p>
          <button type="submit" disabled={loading} className="w-full rounded-b-sm bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
            {loading ? "Summarizing…" : "Summarize files"}
          </button>
        </form>
        {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
        {loading && <p role="status" className="mt-4 text-sm text-slate-500">Creating your summary…</p>}
        {text && (
          <section className="mt-6 rounded-b-sm border border-slate-200 bg-slate-50 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Your summary</h2>
            <p className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{text}</p>
          </section>
        )}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
          <label htmlFor="speech-voice" className="block text-sm font-medium text-slate-700">
            Voice
          </label>
          <select
            id="speech-voice"
            value={voiceURI}
            onChange={(event) => setVoiceURI(event.target.value)}
            className="w-full rounded-b-sm border border-slate-300 bg-white p-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Default voice</option>
            {filteredVoices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </select>
          </div>
          <div className="min-w-0 space-y-2">
            <label htmlFor="speech-language" className="block text-sm font-medium text-slate-700">
              Language
            </label>
            <select
              id="speech-language"
              value={language}
              onChange={(event) => {
                const nextLanguage = event.target.value;
                setLanguage(nextLanguage);
                if (!voices.some((voice) => voice.voiceURI === voiceURI && (!nextLanguage || voice.lang === nextLanguage))) {
                  setVoiceURI("");
                }
              }}
              className="w-full rounded-b-sm border border-slate-300 bg-white p-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All languages</option>
              {languages.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-5 space-y-2">
          <label htmlFor="speech-rate" className="block text-sm font-medium text-slate-700">
            Speed: {rate.toFixed(1)}×
          </label>
          <input
            id="speech-rate"
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
            aria-valuetext={`${rate.toFixed(1)} times normal speed`}
            className="block w-full accent-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          />
        </div>
        <div className="mt-5 flex flex-wrap gap-3" role="group" aria-label="Audio playback">
        <button className="flex-1 rounded-b-sm bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => start()} disabled={loading || !text || speechStatus === "started"}>
          Play
        </button>
        <button className="flex-1 rounded-b-sm border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => pause()} disabled={speechStatus !== "started"}>
          Pause
        </button>
        <button className="flex-1 rounded-b-sm border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => stop()} disabled={speechStatus === "stopped"}>
          Stop
        </button>
        </div>
      </div>
    </main>
  );
}
