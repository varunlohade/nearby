// The first screen explains what nearby is, so nobody needs it explained.
// First-time visitors read the overview while the globe loads, then press
// "Explore <area>"; returning visitors fly straight in. A "What is nearby?"
// button in the top bar reopens the same overview later.

import './landing.css';

interface Feature { icon: string; title: string; text: string }

const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
export const FEATURES: Feature[] = [
  { icon: icon('<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11Z"/>'),
    title: 'Live map', text: 'See events, meetups and people near you, anywhere on Earth.' },
  { icon: icon('<circle cx="12" cy="12" r="9"/><path d="m12 8 4 3-2 5h-4l-2-5z"/>'),
    title: 'Live local games', text: 'Pick what happens next in a game near you and follow each round.' },
  { icon: icon('<path d="M4 5h11v8H8l-4 3V5Z"/><path d="M15 9h5v8l-3-2h-5v-2"/>'),
    title: 'Talk to people', text: 'Chat with your neighbours, your communities and people around the world.' },
  { icon: icon('<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="5"/><path d="m10.5 12 1 1 2-2"/>'),
    title: 'AI local guide', text: 'Ask anything. It pins places, plans walks, checks reviews and moves the map.' },
  { icon: icon('<path d="M4 10h16l-2-6H6l-2 6Zm1 1v9h14v-9M9 20v-6h5v6"/>'),
    title: 'City marketplace', text: 'List something for pickup or call dibs on a neighbour’s find.' },
  { icon: icon('<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>'),
    title: 'Your own agent', text: 'Connect OpenClaw, Hermes or any MCP agent to ask the community for you.' },
];

const featureList = () => `<ul class="landing-features">${FEATURES.map(f =>
  `<li><span class="landing-icon">${f.icon}</span><span><b>${f.title}</b><small>${f.text}</small></span></li>`).join('')}</ul>`;

const SEEN = 'nearby.seenIntro';

export function mountLanding() {
  const arrival = document.querySelector<HTMLElement>('#arrival')!;
  const copy = arrival.querySelector('#arrival-copy')!;
  const block = document.createElement('div');
  block.className = 'landing';
  block.innerHTML = `${featureList()}
    <p class="landing-privacy"><span aria-hidden="true">◎</span> Your exact location is never shared. Only your area.</p>`;
  copy.after(block);

  const cta = document.createElement('div');
  cta.className = 'landing-cta';
  cta.hidden = true;
  cta.innerHTML = `<button type="button" class="landing-go"></button><button type="button" class="landing-change">Not your area?</button>`;
  arrival.append(cta);

  // "What is nearby?" in the top bar reopens the overview.
  const about = document.createElement('dialog');
  about.className = 'location-dialog landing-about';
  about.innerHTML = `<div class="dialog-card">
      <button class="round-button ghost dialog-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
      <span class="mono kicker">What is nearby?</span>
      <h2>Your world, live.</h2>
      <p>See what's happening around you, start something anywhere, and talk to people nearby and around the world.</p>
      ${featureList()}
      <p class="landing-privacy"><span aria-hidden="true">◎</span> Your exact location is never shared. Only your area.</p>
    </div>`;
  document.body.append(about);
  about.querySelector<HTMLButtonElement>('.dialog-close')!.onclick = () => about.close();
  about.addEventListener('click', event => { if (event.target === about) about.close(); });
  const aboutButton = document.createElement('button');
  aboutButton.type = 'button';
  aboutButton.className = 'round-button landing-about-button';
  aboutButton.setAttribute('aria-label', 'What is nearby?');
  aboutButton.title = 'What is nearby?';
  aboutButton.textContent = '?';
  aboutButton.onclick = () => about.showModal();
  document.querySelector('.top-actions')?.prepend(aboutButton);

  // If the visitor picks another area from "Not your area?", the app starts that
  // landing itself: tidy the first-visit buttons away when it does.
  new MutationObserver(() => {
    if (!cta.hidden && /^Landing in/i.test(document.querySelector('#arrival-title')?.textContent ?? '')) {
      cta.hidden = true;
      arrival.classList.remove('landing-waiting');
      arrival.classList.add('landing-flying');
    }
  }).observe(document.querySelector('#arrival-title')!, { childList: true, characterData: true, subtree: true });

  return {
    /** Wait for a first-time visitor to press "Explore"; returning visitors continue at once. */
    ready(locality: string): Promise<void> {
      const quick = localStorage.getItem(SEEN) || new URLSearchParams(location.search).has('instant');
      const go = () => { localStorage.setItem(SEEN, '1'); cta.hidden = true; arrival.classList.add('landing-flying'); };
      if (quick) { go(); return Promise.resolve(); }
      cta.querySelector('.landing-go')!.textContent = `Explore ${locality} →`;
      cta.hidden = false;
      arrival.classList.add('landing-waiting');
      cta.querySelector<HTMLButtonElement>('.landing-go')!.focus({ preventScroll: true });
      return new Promise(resolve => {
        const done = () => { arrival.classList.remove('landing-waiting'); go(); resolve(); };
        cta.querySelector<HTMLButtonElement>('.landing-go')!.onclick = done;
        cta.querySelector<HTMLButtonElement>('.landing-change')!.onclick = () => {
          // Choosing another area also counts as "go": the search lands there itself.
          localStorage.setItem(SEEN, '1');
          document.querySelector<HTMLDialogElement>('#location-dialog')?.showModal();
        };
      });
    },
  };
}
