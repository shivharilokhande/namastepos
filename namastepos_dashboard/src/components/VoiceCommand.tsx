// Voice ordering stub (F43) — Web Speech API.
// Drop <VoiceCommand onText={...} /> onto the POS to accept "2 paneer tikka,
// one naan" → parses → appends to cart.

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function VoiceCommand({ onText }: { onText: (text: string) => void }) {
  const [recording, setRecording] = useState(false);
  const recogRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.lang = 'en-IN';
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      onText(text);
      setRecording(false);
    };
    r.onend = () => setRecording(false);
    recogRef.current = r;
  }, [onText]);

  if (!recogRef.current && typeof window !== 'undefined' &&
      !((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) {
    return null; // unsupported browser
  }

  const toggle = () => {
    if (recording) recogRef.current?.stop();
    else { recogRef.current?.start(); setRecording(true); }
  };

  return (
    <Button size="sm" variant={recording ? 'destructive' : 'outline'} onClick={toggle} type="button">
      {recording ? <MicOff className="h-4 w-4 mr-1" /> : <Mic className="h-4 w-4 mr-1" />}
      {recording ? 'Listening…' : 'Voice'}
    </Button>
  );
}

// Helper: parse a spoken phrase into cart hints.
// "two paneer tikka one naan" → [{ name: 'paneer tikka', qty: 2 }, ...]
export function parseSpokenOrder(text: string): { name: string; qty: number }[] {
  const NUMS: Record<string, number> = {
    one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  };
  const lower = text.toLowerCase().replace(/[^\w\s]/g, ' ');
  const tokens = lower.split(/\s+/).filter(Boolean);
  const items: { name: string; qty: number }[] = [];
  let i = 0;
  while (i < tokens.length) {
    let qty = 1;
    if (/^\d+$/.test(tokens[i])) { qty = Number(tokens[i]); i += 1; }
    else if (NUMS[tokens[i]]) { qty = NUMS[tokens[i]]; i += 1; }
    // grab up to 4 words as name until next number
    const nameParts: string[] = [];
    while (i < tokens.length && !/^\d+$/.test(tokens[i]) && !NUMS[tokens[i]] && nameParts.length < 4) {
      nameParts.push(tokens[i]); i += 1;
    }
    if (nameParts.length > 0) items.push({ name: nameParts.join(' '), qty });
  }
  return items;
}
