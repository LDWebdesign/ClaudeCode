/**
 * Seven-segment LCD readout drawn in SVG, unlit segments faintly visible like real glass.
 * Digits are slightly italic, as on most receiver displays.
 */
const NS = 'http://www.w3.org/2000/svg';
const DIGIT_W = 30;
const DIGIT_H = 52;
const GAP = 8;
const T = 5; // segment thickness

// segment polygons for one digit (a..g), in a 30x52 box
function segs(): string[] {
  const w = DIGIT_W, h = DIGIT_H, t = T, m = h / 2, k = t / 2;
  const hz = (x0: number, x1: number, y: number) => `${x0 + k},${y} ${x0 + t},${y - k} ${x1 - t},${y - k} ${x1 - k},${y} ${x1 - t},${y + k} ${x0 + t},${y + k}`;
  const vt = (x: number, y0: number, y1: number) => `${x},${y0 + k} ${x + k},${y0 + t} ${x + k},${y1 - t} ${x},${y1 - k} ${x - k},${y1 - t} ${x - k},${y0 + t}`;
  return [
    hz(k, w - k, k), // a
    vt(w - k, k, m), // b
    vt(w - k, m, h - k), // c
    hz(k, w - k, h - k), // d
    vt(k, m, h - k), // e
    vt(k, k, m), // f
    hz(k, w - k, m), // g
  ];
}

const MAP: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '',
};

export class SevenSeg {
  readonly el: SVGSVGElement;
  private digits: SVGPolygonElement[][] = [];
  private dp: SVGCircleElement[] = [];
  private last = '';

  constructor(private readonly count: number) {
    const width = count * DIGIT_W + (count - 1) * GAP + 6;
    this.el = document.createElementNS(NS, 'svg');
    this.el.setAttribute('viewBox', `-2 -1 ${width} ${DIGIT_H + 2}`);
    this.el.setAttribute('aria-hidden', 'true');
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', 'skewX(-6) translate(3 0)');
    this.el.append(g);
    const shapes = segs();
    for (let d = 0; d < count; d++) {
      const x = d * (DIGIT_W + GAP);
      const list: SVGPolygonElement[] = [];
      for (const pts of shapes) {
        const p = document.createElementNS(NS, 'polygon');
        p.setAttribute('points', pts);
        p.setAttribute('transform', `translate(${x} 0)`);
        p.setAttribute('class', 'seg-off');
        g.append(p);
        list.push(p);
      }
      this.digits.push(list);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(x + DIGIT_W + GAP / 2));
      c.setAttribute('cy', String(DIGIT_H - 2.5));
      c.setAttribute('r', '2.6');
      c.setAttribute('class', 'seg-off');
      g.append(c);
      this.dp.push(c);
    }
  }

  /** e.g. "104.3", " 88.1", "1240", "----" */
  set(text: string): void {
    if (text === this.last) return;
    this.last = text;
    const chars: string[] = [];
    const dots: boolean[] = [];
    for (const ch of text) {
      if (ch === '.') dots[chars.length - 1] = true;
      else chars.push(ch);
    }
    while (chars.length < this.count) {
      chars.unshift(' ');
      dots.unshift(false);
    }
    for (let d = 0; d < this.count; d++) {
      const on = MAP[chars[d]] ?? '';
      this.digits[d].forEach((p, i) => p.setAttribute('class', on.includes('abcdefg'[i]) ? 'seg-on' : 'seg-off'));
      this.dp[d].setAttribute('class', dots[d] && d < this.count - 1 ? 'seg-on' : 'seg-off');
    }
  }
}
