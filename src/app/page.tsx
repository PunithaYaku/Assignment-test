"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, Send, Settings, User, Mic, Image as ImageIcon, Loader2, Calendar, CheckCircle } from "lucide-react";

type Role = "user" | "assistant" | "system";
interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  ts: number;
}

const DEFAULT_QUICK: string[] = [
  "Book a room for next Tuesday",
  "Check availability for 2 people",
  "What are your room rates?",
  "Cancel my reservation",
  "Do you have a gym?",
];

const brand = {
  primary: "from-blue-500 to-indigo-600",
  glow: "shadow-[0_0_60px_rgba(59,130,246,0.35)]",
  pill: "bg-blue-500/10 text-blue-300 border border-blue-500/30",
  ring: "focus-visible:ring-blue-400",
};

function useLocalStorage(key: string, initial: string) {
  const [value, setValue] = useState<string>("");
  useEffect(() => {
    const v = localStorage.getItem(key);
    setValue(v ?? initial);
  }, [key, initial]);
  useEffect(() => {
    if (value !== "") localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

function classNames(...cls: (string | false | null | undefined)[]) {
  return cls.filter(Boolean).join(" ");
}

function genId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseWebhookText(text: string, contentType?: string | null): string {
  const t = text ?? "";
  const trimmed = t.trim();

  const looksJson = (contentType && contentType.includes("application/json")) || /^[\[{\"]/.test(trimmed);
  if (looksJson) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      if (isRecord(parsed)) {
        const reply = parsed.reply;
        if (typeof reply === "string") return reply;
        const data = parsed.data;
        if (isRecord(data) && typeof data.reply === "string") return data.reply;
        const choices = (parsed as Record<string, unknown>).choices;
        if (Array.isArray(choices)) {
          const first = choices[0] as unknown;
          if (isRecord(first)) {
            const message = first.message as unknown;
            if (isRecord(message) && typeof message.content === "string") return message.content;
          }
        }
        return `\n${JSON.stringify(parsed, null, 2)}`;
      }
      return String(parsed);
    } catch {
      // fall through to HTML/plain handling
    }
  }

  if (trimmed.startsWith("<")) {
    try {
      const lower = trimmed.toLowerCase();
      if (lower.includes("<iframe") && lower.includes("srcdoc=")) {
        const doc = new DOMParser().parseFromString(trimmed, "text/html");
        const iframe = doc.querySelector("iframe[srcdoc]");
        const src = iframe?.getAttribute("srcdoc") ?? "";
        if (src) {
          const inner = new DOMParser().parseFromString(src, "text/html");
          const plain = inner.body.textContent ?? "";
          if (plain.trim()) return plain.trim();
        }
        return "";
      }
      const doc = new DOMParser().parseFromString(trimmed, "text/html");
      const plain = doc.body.textContent ?? "";
      if (plain.trim()) return plain.trim();
    } catch {
      // ignore
    }
  }

  return t || "(No response body)";
}

async function postToWebhook(webhookUrl: string, formData: FormData): Promise<string> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    body: formData,
    mode: "cors",
  });
  const contentType = res.headers.get("content-type");
  const text = await res.text();
  return parseWebhookText(text, contentType);
}

export default function BookingBot() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: genId(),
      role: "assistant",
      ts: Date.now(),
      content:
        "Hello! I’m your Booking Bot assistant. I can help you check availability, book rooms, or answer questions about our services.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  // Default to environment variable if set, otherwise production for deployment
  const [webhookUrl, setWebhookUrl] = useLocalStorage("bookingbot:webhook", process.env.NEXT_PUBLIC_WEBHOOK_URL || "https://agents.telikos-engineering.com/webhook-test/f27f2ea6-0199-4b5c-b72a-6db4206b7248");
  const [chatId] = useLocalStorage("bookingbot:chatId", genId());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftWebhook, setDraftWebhook] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const handleSend = async (text?: string, audioFile?: File) => {
    const body = (text ?? input).trim();
    if (!body && !attachedImage && !audioFile) return;

    setInput("");
    const currentImage = attachedImage;
    setAttachedImage(null);

    const userMsg: ChatMessage = {
      id: genId(),
      role: "user",
      content: body + (currentImage ? " [Image Attached]" : "") + (audioFile ? " [Audio Attached]" : ""),
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const waitingId = genId();
    setMessages((prev) => [
      ...prev,
      {
        id: waitingId,
        role: "assistant",
        content: "…",
        ts: Date.now(),
      },
    ]);

    setSending(true);
    try {
      if (!webhookUrl) throw new Error("Missing webhook URL");

      const formData = new FormData();
      const msgType = audioFile ? "audio" : (currentImage ? "image" : "text");
      formData.append("type", msgType);
      formData.append("text", body);
      formData.append("source", "booking-bot");
      formData.append("chatId", chatId);
      formData.append("metadata", JSON.stringify({ ts: Date.now(), client: "web", chatId }));

      if (currentImage) {
        formData.append("image", currentImage);
      }
      if (audioFile) {
        formData.append("audio", audioFile);
      }

      const reply = await postToWebhook(webhookUrl, formData);
      setMessages((prev) => prev.map((m) => (m.id === waitingId ? { ...m, content: reply || "(empty)" } : m)));
    } catch {
      const demo =
        "(Demo) I couldn’t reach your n8n webhook. once it’s running, set the URL in Settings.\n\nSample response: \"I have checked availability for those dates. We have a Deluxe Suite available.\"";
      setMessages((prev) => prev.map((m) => (m.id === waitingId ? { ...m, content: demo } : m)));
    } finally {
      setSending(false);
    }
  };

  const handleQuick = (q: string) => handleSend(q);

  const toggleRecording = async () => {
    if (recording) {
      mediaRecorder?.stop();
      setRecording(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const file = new File([blob], "voice-recording.webm", { type: 'audio/webm' });
          handleSend("", file);
          stream.getTracks().forEach(t => t.stop());
        };

        recorder.start();
        setMediaRecorder(recorder);
        setRecording(true);
      } catch (err) {
        console.error("Mic access denied", err);
        alert("Could not access microphone.");
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAttachedImage(file);
    }
  };

  return (
    <TooltipProvider>
      <div className="relative min-h-dvh w-full overflow-hidden bg-slate-950 text-slate-100">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/20 via-slate-950 to-slate-950" />

        <header className="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5">
          <div className="flex items-center gap-3">
            <div className={`grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br ${brand.primary} text-white shadow-lg shadow-blue-600/30`}>
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-blue-100">Booking Bot</h1>
              <p className="text-xs text-blue-300/70">Your Booking Assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={classNames(brand.pill, "rounded-full px-3 py-1 text-xs")}>beta</Badge>
              </TooltipTrigger>
              <TooltipContent>Prototype UI. Connect to n8n to go live.</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  className={classNames("border border-blue-500/30 bg-white/10 text-blue-100 hover:bg-white/20", brand.ring)}
                  onClick={() => {
                    setDraftWebhook(webhookUrl || "http://localhost:5678/webhook/booking-bot");
                    setSettingsOpen(true);
                  }}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Set the Webhook URL.</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main className="relative z-10 mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-4 pb-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="flex flex-wrap items-center gap-2"
          >
            {DEFAULT_QUICK.map((q) => (
              <Button
                key={q}
                variant="outline"
                size="sm"
                className={classNames(
                  "rounded-full border-blue-500/30 text-slate-300 hover:bg-blue-500/10 hover:text-white",
                  brand.ring
                )}
                onClick={() => handleQuick(q)}
              >
                {q}
              </Button>
            ))}
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35 }}>
            <Card className={classNames("border-blue-500/20 bg-slate-900/60 backdrop-blur-xl", brand.glow)}>
              <CardHeader className="border-b border-blue-500/10 pb-3">
                <CardTitle className="flex items-center gap-2 text-blue-200">
                  <Bot className="h-5 w-5" /> Booking Assistant
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[56vh] w-full">
                  <div className="space-y-4 p-4">
                    {messages.map((m) => (
                      <ChatBubble key={m.id} msg={m} />
                    ))}
                    {sending && (
                      <div className="flex items-center gap-2 pl-1 text-blue-300/80">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        thinking…
                      </div>
                    )}
                    <div ref={endRef} />
                  </div>
                </ScrollArea>
              </CardContent>
              <CardFooter className="flex-col border-t border-blue-500/10 p-3 gap-2">
                {attachedImage && (
                  <div className="flex w-full items-center gap-2 rounded bg-blue-900/20 px-3 py-2 text-xs text-blue-200">
                    <CheckCircle className="h-3 w-3 text-green-400" />
                    Image attached
                    <button onClick={() => setAttachedImage(null)} className="ml-auto hover:text-white">x</button>
                  </div>
                )}
                <form
                  className="flex w-full items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSend();
                  }}
                >
                  <div className="flex gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={toggleRecording}
                          className={classNames(
                            "h-9 w-9 text-slate-400 hover:text-blue-200 hover:bg-white/5",
                            recording && "text-red-500 animate-pulse hover:text-red-400"
                          )}
                        >
                          <Mic className="h-5 w-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{recording ? "Stop Recording" : "Voice Input"}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-10 w-10 text-blue-300 hover:bg-blue-500/10 hover:text-white"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <ImageIcon className="h-5 w-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Upload Image</TooltipContent>
                    </Tooltip>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      accept="image/*"
                      className="hidden"
                    />
                  </div>

                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={
                      webhookUrl
                        ? "Type a message…"
                        : "Set your Webhook URL in Settings..."
                    }
                    rows={1}
                    className={classNames(
                      "min-h-[44px] flex-1 resize-none bg-slate-950/50 text-slate-100 placeholder:text-slate-500 border-blue-500/30",
                      brand.ring
                    )}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          type="submit"
                          disabled={!input.trim() && !attachedImage}
                          className={`bg-gradient-to-br ${brand.primary} text-white shadow-lg shadow-blue-500/30 hover:opacity-95`}
                        >
                          <Send className="mr-2 h-4 w-4" /> Send
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Enter ↵ to send</TooltipContent>
                  </Tooltip>
                </form>
              </CardFooter>
            </Card>
          </motion.div>

          <div className="flex flex-wrap justify-center items-center gap-4 text-xs text-slate-400">
            <div className="flex items-center gap-1"><Calendar className="h-3 w-3" /> Check Availability</div>
            <div className="flex items-center gap-1"><CheckCircle className="h-3 w-3" /> Instant Confirmation</div>
          </div>

        </main>
        <footer className="relative z-10 mx-auto w-full max-w-5xl px-4 pb-6 pt-2 text-xs text-slate-400/60">
          <p>
            Backend by <span className="text-blue-300">n8n</span>. Messages are POSTed to your Webhook URL as <code className="rounded bg-black/30 px-1">{`{ text, source, metadata, image }`}</code>.
          </p>
        </footer>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-md bg-slate-900 border-blue-500/20 text-slate-100">
            <DialogHeader>
              <DialogTitle>Webhook settings</DialogTitle>
              <DialogDescription className="text-slate-400">Enter your n8n Webhook URL to connect the bot.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-500 font-medium">Webhook URL</label>
                <div className="flex gap-2">
                  <Input
                    value={draftWebhook}
                    onChange={(e) => setDraftWebhook(e.target.value)}
                    placeholder="https://agents.telikos-engineering.com/..."
                    className="bg-slate-950/50 border-blue-500/30 text-slate-100 placeholder:text-slate-600"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 shrink-0"
                    onClick={() => setDraftWebhook(process.env.NEXT_PUBLIC_WEBHOOK_URL || "https://agents.telikos-engineering.com/webhook-test/f27f2ea6-0199-4b5c-b72a-6db4206b7248")}
                  >
                    Default
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSettingsOpen(false)} className="hover:bg-slate-800 hover:text-white">Cancel</Button>
              <Button
                type="button"
                className="bg-blue-600 hover:bg-blue-500 text-white"
                onClick={() => {
                  setWebhookUrl(draftWebhook.trim());
                  setSettingsOpen(false);
                }}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={classNames("flex w-full gap-2", isUser ? "justify-end" : "justify-start")}
    >
      {!isUser && (
        <Avatar className="h-8 w-8 ring-2 ring-blue-500/30">
          <AvatarFallback className="bg-blue-600/20 text-blue-200">
            <Bot className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
      <div
        className={classNames(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser ? "bg-blue-600 text-white" : "bg-slate-800/80 text-slate-200 border border-slate-700"
        )}
        style={{ whiteSpace: "pre-wrap" }}
      >
        {msg.content}
      </div>
      {isUser && (
        <Avatar className="h-8 w-8 ring-2 ring-blue-500/30">
          <AvatarFallback className="bg-indigo-600/20 text-indigo-200">
            <User className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </motion.div>
  );
}
