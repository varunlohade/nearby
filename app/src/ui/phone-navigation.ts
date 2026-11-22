export type PhonePanel =
  | {type: 'activities'}
  | {type: 'chat'}
  | {type: 'preview' | 'event-chat'; id: string}
  | {type: 'room'; id: string; title: string; kind: string};

// One history entry per visible layer. A dock shortcut replaces the panel it
// dismissed. A dialog that leaves a preview underneath gets its own entry.
export function mountPhoneNavigation(
  getPanel: () => PhonePanel | undefined,
  showPanel: (panel: PhonePanel | undefined) => void,
) {
  const phone = matchMedia('(max-width: 720px)');
  const dialogs = {
    market: document.querySelector<HTMLDialogElement>('.mk-dialog')!,
    games: document.querySelector<HTMLDialogElement>('.city-games')!,
  };
  type Board = keyof typeof dialogs;
  type View = { panel?: PhonePanel; board?: Board };
  const boards: Board[] = ['market', 'games'];
  const depth = (view: View) => Number(Boolean(view.panel)) + Number(Boolean(view.board));
  const read = (): View => phone.matches && document.body.matches('.on-map:not(.roam-open)')
    ? {panel: getPanel(), board: boards.find(board => dialogs[board].open)}
    : {};
  const samePanel = (a?: PhonePanel, b?: PhonePanel) => JSON.stringify(a) === JSON.stringify(b);
  const entry = (): View => history.state?.nearbyMap ?? {};
  let traversing = false;
  let restoring = false;

  function sync() {
    if (traversing || restoring) return;
    const next = read();
    const current = entry();
    if (samePanel(next.panel, current.panel) && next.board === current.board) return;
    const delta = depth(next) - depth(current);
    if (delta < 0) {
      traversing = true;
      history.go(delta);
      return;
    }
    const state = {...history.state, nearbyMap: next};
    if (delta === 2) history.pushState({...history.state, nearbyMap: {panel: next.panel}}, '');
    if (delta > 0) history.pushState(state, '');
    else history.replaceState(state, '');
  }

  // Native dialog cancellation, close buttons and surface-to-surface shortcuts
  // all update these same attributes. Read after all handlers for the tap finish.
  let timer: number;
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(sync, 0);
  }
  const observer = new MutationObserver(schedule);
  for (const board of boards) {
    const dialog = dialogs[board];
    observer.observe(dialog, {attributeFilter: ['open']});
    dialog.addEventListener('cancel', event => {
      if (event.defaultPrevented || !phone.matches || entry().board !== board) return;
      // Escape and browser Back dismiss the same entry. Keep the dialog open
      // until popstate so the underlying panel and its history agree immediately.
      event.preventDefault();
      history.back();
    });
  }
  for (const selector of ['body', '#activity-panel', '#chat-panel', '#event-sheet']) {
    observer.observe(document.querySelector(selector)!, {attributeFilter: ['class']});
  }
  // Commit the opening tap before the browser can process a Back gesture.
  window.addEventListener('click', sync);
  document.addEventListener('close', sync, true);
  phone.addEventListener('change', schedule);
  addEventListener('popstate', () => {
    clearTimeout(timer);
    if (traversing) {
      // A close button already updated the UI. Process any newer tap now.
      traversing = false;
      sync();
      return;
    }
    if (!phone.matches || !document.body.classList.contains('on-map')) return;
    const next = entry();
    restoring = true;
    for (const board of boards) {
      if (dialogs[board].open && next.board !== board) dialogs[board].close();
    }
    if (!samePanel(getPanel(), next.panel)) showPanel(next.panel);
    if (next.board && !dialogs[next.board].open) {
      const trigger = next.board === 'games' && next.panel?.type === 'preview'
        ? '#event-predictions' : `.phone-dock [data-city-${next.board}]`;
      document.querySelector<HTMLButtonElement>(trigger)?.click();
    }
    restoring = false;
    schedule();
  });
}
