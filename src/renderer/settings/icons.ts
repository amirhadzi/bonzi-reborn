// Small inline SVG icons (stroke based, 20x20, currentColor).

const SVG_NS = 'http://www.w3.org/2000/svg';

type Shape =
  | { p: string; fill?: boolean }
  | { c: [number, number, number]; fill?: boolean };

const ICONS: Readonly<Record<string, readonly Shape[]>> = {
  account: [
    { c: [6.8, 13.2, 3.6] },
    { p: 'M9.4 10.6L16.5 3.5' },
    { p: 'M14.2 5.8l2 2' },
    { p: 'M12.2 7.8l1.6 1.6' },
  ],
  brain: [
    { p: 'M9 2.8l1.5 4.2 4.2 1.5-4.2 1.5L9 14.2 7.5 10 3.3 8.5 7.5 7z' },
    { p: 'M15 12.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z' },
  ],
  voice: [
    { p: 'M3 7.6h2.9L10 4v12l-4.1-3.6H3z' },
    { p: 'M13 7.4a3.8 3.8 0 0 1 0 5.2' },
    { p: 'M15.2 5.2a7 7 0 0 1 0 9.6' },
  ],
  listening: [
    { p: 'M10 2.6a2.6 2.6 0 0 1 2.6 2.6v4.2a2.6 2.6 0 0 1-5.2 0V5.2A2.6 2.6 0 0 1 10 2.6z' },
    { p: 'M4.8 9.4a5.2 5.2 0 0 0 10.4 0' },
    { p: 'M10 14.6v2.8' },
    { p: 'M7.4 17.4h5.2' },
  ],
  character: [
    { c: [10, 10, 7.4] },
    { p: 'M7 11.8a3.6 3.6 0 0 0 6 0' },
    { c: [7.5, 8.2, 0.9], fill: true },
    { c: [12.5, 8.2, 0.9], fill: true },
  ],
  app: [
    { p: 'M4.5 3.5h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z' },
    { p: 'M2.5 7h15' },
    { c: [5, 5.25, 0.6], fill: true },
    { c: [7, 5.25, 0.6], fill: true },
  ],
  external: [
    { p: 'M8.5 4.5H5.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3' },
    { p: 'M11.5 4.5h4v4' },
    { p: 'M15.5 4.5L9 11' },
  ],
  check: [{ p: 'M4.5 10.5l3.4 3.4 7.6-8' }],
  warning: [
    { p: 'M10 3.2l7.4 13H2.6z' },
    { p: 'M10 8.2v3.6' },
    { c: [10, 14, 0.7], fill: true },
  ],
  error: [
    { c: [10, 10, 7.4] },
    { p: 'M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2' },
  ],
  info: [
    { c: [10, 10, 7.4] },
    { p: 'M10 9v4.6' },
    { c: [10, 6.6, 0.8], fill: true },
  ],
  play: [{ p: 'M6.5 4.5v11l9-5.5z' }],
  stop: [{ p: 'M5.5 5.5h9v9h-9z' }],
  refresh: [
    { p: 'M15.6 8.2A6 6 0 0 0 4.4 7' },
    { p: 'M4.4 11.8a6 6 0 0 0 11.2 1.2' },
    { p: 'M15.8 3.8v4.6h-4.6' },
    { p: 'M4.2 16.2v-4.6h4.6' },
  ],
  folder: [{ p: 'M2.8 5.5a1.5 1.5 0 0 1 1.5-1.5h3.4l1.8 2h6.2a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4.3a1.5 1.5 0 0 1-1.5-1.5z' }],
  trash: [
    { p: 'M3.8 5.6h12.4' },
    { p: 'M8 5.6V4h4v1.6' },
    { p: 'M5.4 5.6l.8 10.4h7.6l.8-10.4' },
  ],
  plug: [
    { p: 'M7 2.8v3.6M13 2.8v3.6' },
    { p: 'M5 6.4h10v3a5 5 0 0 1-10 0z' },
    { p: 'M10 14.4v2.8' },
  ],
  chevron: [{ p: 'M7.5 4.5l5.5 5.5-5.5 5.5' }],
  shield: [
    { p: 'M10 2.6l6 2.4v4.6c0 3.8-2.6 6.6-6 7.8-3.4-1.2-6-4-6-7.8V5z' },
    { p: 'M7.4 10l1.9 1.9 3.5-3.7' },
  ],
};

export type IconName = keyof typeof ICONS;

export function icon(name: string, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const shape of ICONS[name] ?? []) {
    let node: SVGElement;
    if ('p' in shape) {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', shape.p);
    } else {
      node = document.createElementNS(SVG_NS, 'circle');
      node.setAttribute('cx', String(shape.c[0]));
      node.setAttribute('cy', String(shape.c[1]));
      node.setAttribute('r', String(shape.c[2]));
    }
    if (shape.fill) node.setAttribute('class', 'fill');
    svg.append(node);
  }
  return svg;
}

/** Colourful banana used in the header and About card. */
export function bananaIcon(className = 'banana'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const parts: Array<[string, string]> = [
    ['banana-body', 'M6 17.5C9 23.6 18.6 25 23.8 19c2.8-3.2 3.4-7.6 2.4-11.5l-2.8.3c.4 3.2-.5 6.3-2.9 8.4-4 3.5-10 3.4-13.1-.2z'],
    ['banana-shade', 'M6.8 18.7c3.6 4.6 11.5 5.3 16.2.4 2.4-2.6 3.3-6 3.1-9.3-.6 3.6-2.6 6.8-5.6 8.6-4.4 2.7-9.8 2.6-13.7.3z'],
    ['banana-stem', 'M23.4 7.8l-.4-3.1c-.1-.7.5-1.2 1.1-1l1 .3c.5.2.8.6.8 1.1l.3 2.4z'],
    ['banana-tip', 'M6 17.5l1.4-1.5-1.7-.5c-.7-.1-1.1.6-.7 1.1z'],
  ];
  for (const [cls, d] of parts) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    svg.append(p);
  }
  return svg;
}
