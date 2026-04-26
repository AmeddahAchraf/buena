// Tiny inline SVG icon set. No external dep. Stroke 1.5, 16px default.

type P = { size?: number; className?: string };
const base = "stroke-current fill-none";

export const I = {
  Search: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  Build: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h18M3 12h18M3 17h18" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
      <circle cx="14" cy="12" r="1" fill="currentColor" />
      <circle cx="10" cy="17" r="1" fill="currentColor" />
    </svg>
  ),
  Inbox: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6" />
      <path d="M22 12h-6l-2 3h-4l-2-3H2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6Z" />
    </svg>
  ),
  Spark: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  ),
  Mail: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  ),
  File: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
  Bank: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 10 9-6 9 6" />
      <path d="M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18" />
    </svg>
  ),
  Letter: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  ),
  Database: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  ),
  Lock: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  ),
  Pin: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5M5 7l7 7 7-7M9 3h6l-1 4h-4z" />
    </svg>
  ),
  Clock: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  X: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  Check: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 12 5 5L20 6" />
    </svg>
  ),
  Warn: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 2 21h20Z" />
      <path d="M12 10v5M12 18v.5" />
    </svg>
  ),
  Eye: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  Chevron: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  Bolt: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h7l-1 8 9-12h-7Z" />
    </svg>
  ),
  Mic: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  ),
  Calendar: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  Building: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" />
    </svg>
  ),
  Source: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="12" cy="20" r="3" />
      <path d="M9 6h6M7 8l3 9M17 8l-3 9" />
    </svg>
  ),
  Menu: ({ size = 14, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  Cog: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  ),
  Filter: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h18l-7 9v6l-4-2v-4Z" />
    </svg>
  ),
  Brain: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4a3 3 0 0 0-3 3v0a3 3 0 0 0-2 5 3 3 0 0 0 2 5v0a3 3 0 0 0 3 3h0a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z" />
      <path d="M15 4a3 3 0 0 1 3 3v0a3 3 0 0 1 2 5 3 3 0 0 1-2 5v0a3 3 0 0 1-3 3h0a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  ),
  Diff: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M5 8h7M5 16h7M19 8h-2M19 16h-2M17 6v4M17 14v4" />
    </svg>
  ),
  Scan: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M21 7V5a2 2 0 0 0-2-2h-2M3 17v2a2 2 0 0 0 2 2h2M21 17v2a2 2 0 0 1-2 2h-2M3 12h18" />
    </svg>
  ),
  Edit: ({ size = 12, className = "" }: P) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  ),
};

export function SourceIcon({ type, size = 14, className = "" }: { type: string; size?: number; className?: string }) {
  switch (type) {
    case "email":
      return <I.Mail size={size} className={className} />;
    case "invoice":
      return <I.File size={size} className={className} />;
    case "bank":
      return <I.Bank size={size} className={className} />;
    case "letter":
      return <I.Letter size={size} className={className} />;
    case "stammdaten":
      return <I.Database size={size} className={className} />;
    default:
      return <I.File size={size} className={className} />;
  }
}

export function DecisionIcon({ d, size = 12, className = "" }: { d: string; size?: number; className?: string }) {
  switch (d) {
    case "durable_fact":
      return <I.Lock size={size} className={className} />;
    case "operational_memory":
      return <I.Pin size={size} className={className} />;
    case "temporary_note":
      return <I.Clock size={size} className={className} />;
    case "ignore":
      return <I.X size={size} className={className} />;
    default:
      return <I.Pin size={size} className={className} />;
  }
}
