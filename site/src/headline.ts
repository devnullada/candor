// The front page's four numbers, worked out from numbers.json so they can't drift from it. A figure
// no run has measured yet is an expected one, marked as such and carrying its basis (Pal, 2026-11-03).

export type Row = { label: string; go: string; candor: string; expected?: string };
export type Card = { id: string; title: string; what: string; rows: Row[] };

const dollars = (n: number, places = 2) => `$${n.toFixed(places)}`;
const about = (n: number) => `~${dollars(n)}`;

export function headlineCards(n: any): Card[] {
  const { go, candor } = n.change.results.byLang;
  const requests = Object.keys(n.change.requests).length;
  const sonnet = `Sonnet, ${requests} requests, 3 runs each, Candor ${n.change.candor}`;

  const agents = n.compare.results.agents;
  const opus = agents.find((a: any) => a.model === 'opus').byLang;
  const sonnetSame = agents.find((a: any) => a.model === 'sonnet').byLang;
  const opusLabel = `Opus, ${Object.keys(n.compare.results.requests).length} requests, 1 run each, Candor ${n.compare.candor}`;

  const same = n.trials.find((t: any) => t.id === 'same-spec');
  const ofLang = (lang: string) => same.results.filter((r: any) => r.lang === lang);
  const perApp = (lang: string) => {
    const runs = ofLang(lang);
    return runs.reduce((sum: number, r: any) => sum + r.dollars, 0) / runs.length;
  };
  const passed = (lang: string) => ofLang(lang).filter((r: any) => r.failed === 0).length;
  const sameLabel = `Sonnet, ${ofLang('candor').length} apps, 1 run each, Candor ${same.candor}`;

  const perAccepted = (g: any) => g.dollars / g.passedAll;
  // What Opus cost against Sonnet on the requests both ran, applied to the Sonnet cost of an app.
  const opusFactor = (lang: 'go' | 'candor') => opus[lang].dollars / opus[lang].runs / (sonnetSame[lang].dollars / sonnetSame[lang].runs);

  const { afterEdit, effects } = n.headline.expected;
  const rows: Record<string, Row[]> = {
    accepted: [
      { label: sonnet, go: `${go.passedAll}/${go.runs}`, candor: `${candor.passedAll}/${candor.runs}` },
      { label: opusLabel, go: `${opus.go.passedAll}/${opus.go.runs}`, candor: `${opus.candor.passedAll}/${opus.candor.runs}` },
    ],
    cost: [
      { label: sonnet, go: dollars(perAccepted(go), 3), candor: dollars(perAccepted(candor), 3) },
      { label: opusLabel, go: dollars(perAccepted(opus.go), 3), candor: dollars(perAccepted(opus.candor), 3) },
      {
        label: 'Sonnet, the part after the first edit',
        go: about(perAccepted(go) * afterEdit.sonnet.go),
        candor: about(perAccepted(candor) * afterEdit.sonnet.candor),
        expected: afterEdit.basis,
      },
      {
        label: 'Opus, the part after the first edit',
        go: about(perAccepted(opus.go) * afterEdit.opus.go),
        candor: about(perAccepted(opus.candor) * afterEdit.opus.candor),
        expected: afterEdit.basis,
      },
    ],
    effects: [
      { label: 'Correct answers', go: `~${effects.correct.go}%`, candor: `~${effects.correct.candor}%`, expected: effects.basis },
      { label: 'Tokens per question', go: `~${effects.tokens.go / 1000}k`, candor: `~${effects.tokens.candor / 1000}k`, expected: effects.basis },
    ],
    newApp: [
      { label: `${sameLabel}, cost per app`, go: dollars(perApp('go')), candor: dollars(perApp('candor')) },
      { label: 'Apps passing every acceptance test', go: `${passed('go')}/${ofLang('go').length}`, candor: `${passed('candor')}/${ofLang('candor').length}` },
      {
        label: 'Opus, cost per app',
        go: about(perApp('go') * opusFactor('go')),
        candor: about(perApp('candor') * opusFactor('candor')),
        expected: n.headline.expected.newAppBasis,
      },
    ],
  };

  return n.headline.numbers.map((c: any) => ({ ...c, rows: rows[c.id] ?? [] }));
}
