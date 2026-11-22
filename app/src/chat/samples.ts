import { esc } from '../ui/icons';

type Exchange = readonly [string, string];

export function sampleChat(kind: string, title: string): string {
  const exchanges: Record<string, Exchange> = {
    Area: ['Anyone know a quiet spot around here for a coffee?', 'I usually grab a cup to go. Want company for a walk?'],
    Event: [`Anyone going to ${title} on their own?`, 'I am! Want to meet at the entrance and head in together?'],
    Community: [`Just joined ${title}. What’s everyone working on?`, 'A few of us are putting together a neighbourhood book swap.'],
    'Audio session': ['I’m listening on my way home. Can I leave my question here?', 'Absolutely. What would you like us to cover?'],
    'Chat room': [`Hi everyone, what got you interested in ${title}?`, 'A neighbour invited me. Glad to meet the group!'],
    Inquiry: [`Is “${title}” still available?`, 'Yes! What would you like to know about it?'],
    Pickup: ['Would early evening work for pickup?', 'That works. Let’s agree on a time here.'],
  };
  const [question, reply] = exchanges[kind] ?? exchanges['Chat room'];
  const market = kind === 'Inquiry' || kind === 'Pickup';
  return `<details class="sample-chat" open><summary>Sample conversation</summary>
    <p><b>${market ? 'Buyer' : 'Mira'}</b> ${esc(question)}</p>
    <p><b>${market ? 'Seller' : 'Dev'}</b> ${esc(reply)}</p></details>`;
}
