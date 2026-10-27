import { expect, it } from 'vitest';
import { navMask, navPath } from '../../app/utils/nav-geometry';
it('keeps round end radius tied to height, not desktop tab width', () => {
  expect(navPath(350,42,'first')).toContain('A 21 21');
  expect(navPath(75,40,'first')).toContain('A 20 20');
  expect(navPath(350,42,'first')).toContain('Q');
});
it('rounds both diagonal transitions and shares fill/outline path', () => {
  for (const position of ['first','middle','last'] as const) {
    const path = navPath(100,40,position);
    expect(path).toContain('Q');
    expect(decodeURIComponent(navMask(100,40,position))).toContain(`d="${path}"`);
    expect(decodeURIComponent(navMask(100,40,position,true))).toContain(`d="${path}"`);
  }
  expect(navPath(100,40,'middle')).not.toContain(' A ');
  expect(navPath(100,40,'last')).toContain('A 20 20');
});

it('uses generous height-relative corner rounding with tangent transitions', () => {
  const path = navPath(100,40,'first');
  // 40 * .32 = 12.8px of horizontal cutback (old corners were only 5px).
  expect(path).toContain('H 87.2 Q 100 0');
  expect(path).toContain('Q 84 40 71.2 40');
});
