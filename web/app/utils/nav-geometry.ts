/** Rounded slanted ends in real CSS pixels, never a horizontally stretched circle. */
export function navPath(width: number, height: number, position: 'first' | 'middle' | 'last') {
  const w = Math.max(32, width), h = Math.max(20, height);
  const r = h / 2, s = Math.min(16, w * .18);
  // Cut back equally along the adjoining edges. The quadratic control point
  // is the original vertex, so the curve is tangent to BOTH straight edges.
  // A height-relative ~13px cutback replaces the old sharp ~5px corners.
  const c = Math.min(h * .32, (w - s) * .24);
  const diagonal = Math.hypot(s, h);
  const dx = s * c / diagonal, dy = h * c / diagonal;
  const leftTop = position === 'first' ? r : s + c;
  const right = position === 'last'
    ? `H ${w-r} A ${r} ${r} 0 0 1 ${w-r} ${h}`
    : `H ${w-c} Q ${w} 0 ${w-dx} ${dy} L ${w-s+dx} ${h-dy} Q ${w-s} ${h} ${w-s-c} ${h}`;
  const left = position === 'first'
    ? `H ${r} A ${r} ${r} 0 0 1 ${r} 0`
    : `H ${c} Q 0 ${h} ${dx} ${h-dy} L ${s-dx} ${dy} Q ${s} 0 ${s+c} 0`;
  return `M ${leftTop} 0 ${right} ${left} Z`;
}
export function navMask(width: number, height: number, position: 'first' | 'middle' | 'last', outline = false) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${navPath(width,height,position)}" fill="${outline ? 'none' : 'white'}"${outline ? ' stroke="white" stroke-width="2"' : ''}/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
