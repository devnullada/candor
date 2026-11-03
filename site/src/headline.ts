// The front page's four numbers, worked out from numbers.json so they can't drift from it. A figure
// no run has measured says so. With `expected` (the local file, on the dev site only) it shows an
// expected figure instead, marked as such and carrying its basis.

export type Row = { label: string; go: string; candor: string; expected?: string } | { label: string; pending: string };
export type Card = { id: string; title: string; what: string; rows: Row[] };

const dollars = (n: number, places = 2) => `$${n.toFixed(places)}`;
const about = (n: number) => `~${dollars(n)}`;

export function headlineCards(n: any, expected?: any): Card[] {
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

  const afterEditRows = (e: any): Row[] => [
    {
      label: 'Sonnet, the part after the first edit',
      go: about(perAccepted(go) * e.sonnet.go),
      candor: about(perAccepted(candor) * e.sonnet.candor),
      expected: e.basis,
    },
    {
      label: 'Opus, the part after the first edit',
      go: about(perAccepted(opus.go) * e.opus.go),
      candor: about(perAccepted(opus.candor) * e.opus.candor),
      expected: e.basis,
    },
  ];
  const effectsRows = (e: any): Row[] => [
    { label: 'Correct answers', go: `~${e.correct.go}%`, candor: `~${e.correct.candor}%`, expected: e.basis },
    { label: 'Tokens per question', go: `~${e.tokens.go / 1000}k`, candor: `~${e.tokens.candor / 1000}k`, expected: e.basis },
  ];

  const rows: Record<string, Row[]> = {
    accepted: [
      { label: sonnet, go: `${go.passedAll}/${go.runs}`, candor: `${candor.passedAll}/${candor.runs}` },
      { label: opusLabel, go: `${opus.go.passedAll}/${opus.go.runs}`, candor: `${opus.candor.passedAll}/${opus.candor.runs}` },
    ],
    cost: [
      { label: sonnet, go: dollars(perAccepted(go), 3), candor: dollars(perAccepted(candor), 3) },
      { label: opusLabel, go: dollars(perAccepted(opus.go), 3), candor: dollars(perAccepted(opus.candor), 3) },
      ...(expected ? afterEditRows(expected.afterEdit) : [{ label: 'The part after the first edit', pending: 'Not split out yet' }]),
    ],
    effects: expected ? effectsRows(expected.effects) : [{ label: 'Correct answers and tokens', pending: 'Not measured yet' }],
    newApp: [
      { label: `${sameLabel}, cost per app`, go: dollars(perApp('go')), candor: dollars(perApp('candor')) },
      { label: 'Apps passing every acceptance test', go: `${passed('go')}/${ofLang('go').length}`, candor: `${passed('candor')}/${ofLang('candor').length}` },
      expected
        ? { label: 'Opus, cost per app', go: about(perApp('go') * opusFactor('go')), candor: about(perApp('candor') * opusFactor('candor')), expected: expected.newAppBasis }
        : { label: 'Opus', pending: 'Not run yet' },
    ],
  };

  return n.headline.numbers.map((c: any) => ({ ...c, rows: rows[c.id] ?? [] }));
}
