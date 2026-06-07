import { useEffect, useRef } from 'react';

import type { ChatMessage } from '../hooks/useAvatarChat';

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: 'You',
  assistant: 'Aria',
  system: 'System',
};

export interface ChatViewProps {
  messages: ChatMessage[];
}

export function ChatView({ messages }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div ref={scrollRef} className="messages" aria-live="polite">
      {messages.map((message) => (
        <div key={message.id} className={`message ${message.role}`}>
          <div className="label">{ROLE_LABEL[message.role]}</div>
          <div className="bubble">{message.text}</div>
        </div>
      ))}
    </div>
  );
}
