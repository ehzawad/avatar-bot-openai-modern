import { Link } from 'react-router';

import './home.css';

function AvatarVisual() {
  return (
    <svg className="home-visual-icon" viewBox="0 0 160 112" aria-hidden="true">
      <defs>
        <linearGradient id="home-avatar-line" x1="18" y1="18" x2="142" y2="94">
          <stop stopColor="#7c5bff" />
          <stop offset="1" stopColor="#5b8cff" />
        </linearGradient>
      </defs>
      <rect x="18" y="14" width="124" height="84" rx="22" fill="rgba(255,255,255,0.035)" />
      <path
        d="M56 72c5-13 14-20 24-20s19 7 24 20"
        fill="none"
        stroke="url(#home-avatar-line)"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <circle cx="80" cy="42" r="18" fill="none" stroke="url(#home-avatar-line)" strokeWidth="6" />
      <path
        d="M42 40h-8m92 0h-8M46 82h-8m84 0h-8"
        fill="none"
        stroke="rgba(230,233,239,0.48)"
        strokeLinecap="round"
        strokeWidth="4"
      />
      <path
        d="M112 58c8 1 13 6 13 13s-5 12-13 13"
        fill="none"
        stroke="#3ddc97"
        strokeLinecap="round"
        strokeWidth="5"
      />
    </svg>
  );
}

function StudioVisual() {
  return (
    <svg className="home-visual-icon" viewBox="0 0 160 112" aria-hidden="true">
      <defs>
        <linearGradient id="home-studio-line" x1="24" y1="20" x2="136" y2="92">
          <stop stopColor="#3ddc97" />
          <stop offset="1" stopColor="#5b8cff" />
        </linearGradient>
      </defs>
      <rect x="20" y="18" width="120" height="76" rx="18" fill="rgba(255,255,255,0.035)" />
      <path
        d="M38 58h10l6-18 10 36 8-25 8 13h42"
        fill="none"
        stroke="url(#home-studio-line)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
      <path
        d="M42 34h38M98 34h20M42 82h34M94 82h24"
        fill="none"
        stroke="rgba(230,233,239,0.42)"
        strokeLinecap="round"
        strokeWidth="4"
      />
      <circle cx="124" cy="58" r="6" fill="#ffb454" />
    </svg>
  );
}

export default function HomeApp() {
  return (
    <main className="home" aria-labelledby="home-title">
      <div className="home-shell">
        <section className="home-hero" aria-describedby="home-subtitle">
          <p className="home-status">OpenAI-only · server-side key · lazy-loaded tools</p>
          <h1 id="home-title">Aria Workbench</h1>
          <p id="home-subtitle" className="home-subtitle">
            One focused workspace for live avatar conversations and Bengali eval dataset
            production.
          </p>
        </section>

        <section className="home-options" aria-label="Choose a tool">
          <Link
            className="home-card home-card--avatar"
            to="/avatar"
            aria-labelledby="home-aria-title"
            aria-describedby="home-aria-desc"
          >
            <span className="home-card-visual">
              <AvatarVisual />
            </span>
            <span className="home-card-body">
              <span id="home-aria-title" className="home-card-title">
                Aria
              </span>
              <span id="home-aria-desc" className="home-card-copy">
                Run live voice chat, rehearse interviews, and drive a 3D talking avatar with
                structured responses.
              </span>
            </span>
            <span className="home-card-cta" aria-hidden="true">
              Open Aria
              <span className="home-arrow">→</span>
            </span>
          </Link>

          <Link
            className="home-card home-card--studio"
            to="/studio"
            aria-labelledby="home-studio-title"
            aria-describedby="home-studio-desc"
          >
            <span className="home-card-visual">
              <StudioVisual />
            </span>
            <span className="home-card-body">
              <span id="home-studio-title" className="home-card-title">
                Bengali Eval Studio
              </span>
              <span id="home-studio-desc" className="home-card-copy">
                Record, transcribe, tag, review, roll back, and export Bengali conversation data
                as txt, jsonl, or csv.
              </span>
            </span>
            <span className="home-card-cta" aria-hidden="true">
              Open Studio
              <span className="home-arrow">→</span>
            </span>
          </Link>
        </section>

        <footer className="home-footer">
          <span>OpenAI calls stay on the FastAPI server.</span>
          <a href="/docs">API docs</a>
        </footer>
      </div>
    </main>
  );
}
